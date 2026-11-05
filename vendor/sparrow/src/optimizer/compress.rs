use crate::config::{CompressionConfig, ShrinkDecayStrategy};
use crate::optimizer::separator::{SeparationOutcome, SeparationState, Separator};
use crate::util::listener::{ReportType, SolutionListener};
use crate::util::terminator::Terminator;
use jagua_rs::probs::spp::entities::{SPInstance, SPProblem, SPSolution};
use jagua_rs::Instant;
use log::info;
use rand::{Rng, RngExt};
use rand::rngs::Xoshiro256PlusPlus;
use std::time::Duration;

#[cfg(test)]
#[path = "compression_state_tests.rs"]
mod state_tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionOutcome {
    Paused,
    Exhausted,
    BoundReached,
}

/// Owned in-memory checkpoint. Keep the separator and pending separation intact
/// between advances; no restoration or random reseeding is needed on resume.
pub struct CompressionState {
    pub separator: Separator,
    pub separation: Option<SeparationState>,
    pub failed_attempts: i32,
    pub attempts: usize,
    pub shrink_step: f32,
    pub active_elapsed: Duration,
    best: SPSolution,
    config: CompressionConfig,
    min_width: f32,
    finished: Option<CompressionOutcome>,
}

impl CompressionState {
    pub fn new(instance: SPInstance, initial: SPSolution, rng: Xoshiro256PlusPlus, config: CompressionConfig) -> Self {
        let mut prob = SPProblem::new(instance.clone());
        prob.restore(&initial);
        // The catalog may contain unused types. They impose no packing bound.
        let mut bound_prob = prob.clone();
        bound_prob.instance.items.retain(|(_, qty)| *qty > 0);
        let min_width = super::minimum_strip_width(&bound_prob);
        Self {
            separator: Separator::new(instance, prob, rng, config.separator_config),
            separation: None,
            failed_attempts: 0,
            attempts: 0,
            shrink_step: config.shrink_range.0,
            active_elapsed: Duration::ZERO,
            best: initial,
            config,
            min_width,
            finished: None,
        }
    }

    pub fn best(&self) -> &SPSolution {
        &self.best
    }

    /// Start another decay cycle only after natural exhaustion, preserving all
    /// separator state and random streams for continued search.
    pub fn restart_cycle(&mut self) -> bool {
        if self.finished != Some(CompressionOutcome::Exhausted) {
            return false;
        }
        self.failed_attempts = 0;
        self.active_elapsed = Duration::ZERO;
        self.finished = None;
        self.shrink_step = self.config.shrink_range.0;
        self.separation = None;
        true
    }

    pub fn advance(&mut self, term: &impl Terminator, listener: &mut impl SolutionListener) -> CompressionOutcome {
        if let Some(outcome) = self.finished {
            return outcome;
        }
        if term.kill() {
            return CompressionOutcome::Paused;
        }
        let start = Instant::now();
        let outcome = loop {
            if self.separation.is_none() {
                let raw_step = match self.config.shrink_decay {
                    ShrinkDecayStrategy::TimeBased => {
                        let elapsed = self.active_elapsed + start.elapsed();
                        let ratio = elapsed.as_secs_f32() / self.config.time_limit.as_secs_f32();
                        self.config.shrink_range.0 + ratio * (self.config.shrink_range.1 - self.config.shrink_range.0)
                    }
                    ShrinkDecayStrategy::FailureBased(r) => self.config.shrink_range.0 * r.powi(self.failed_attempts),
                };
                self.shrink_step = raw_step;
                if raw_step < self.config.shrink_range.1 {
                    break CompressionOutcome::Exhausted;
                }
                let width = self.best.strip_width();
                let gap = width - self.min_width;
                let tolerance = width.abs().max(self.min_width.abs()) * 1e-6;
                if gap <= tolerance {
                    break CompressionOutcome::BoundReached;
                }
                if width * (1.0 - raw_step) < self.min_width {
                    self.shrink_step = (gap / width * 0.5).min(raw_step);
                }
                let next_width = width * (1.0 - self.shrink_step);
                if next_width >= width {
                    break CompressionOutcome::Exhausted;
                }
                listener.report_compression_progress(self.shrink_step);
                self.separator.change_strip_width(width, None);
                self.separator.rollback(&self.best, None);
                let split = self.separator.rng.random_range(0.0..width);
                self.separator.change_strip_width(next_width, Some(split));
                self.separation = Some(self.separator.start_separation());
                self.attempts += 1;
            }
            let pending = self.separation.as_mut().unwrap();
            match self.separator.advance_separation(pending, term, listener) {
                SeparationOutcome::Paused => break CompressionOutcome::Paused,
                SeparationOutcome::Separated => {
                    self.best = pending.best.0.clone();
                    listener.report(ReportType::CmprFeas, &self.best, &self.separator.instance);
                }
                SeparationOutcome::Exhausted => self.failed_attempts += 1,
            }
            self.separation = None;
            if term.kill() {
                break CompressionOutcome::Paused;
            }
        };
        self.active_elapsed += start.elapsed();
        if outcome != CompressionOutcome::Paused {
            self.finished = Some(outcome);
        }
        outcome
    }
}


/// Algorithm 13 from https://doi.org/10.48550/arXiv.2509.13329
pub fn compression_phase(
    instance: &SPInstance,
    sep: &mut Separator,
    init_sol: &SPSolution,
    sol_listener: &mut impl SolutionListener,
    term: &impl Terminator,
    config: &CompressionConfig
) -> SPSolution {
    let min_width = super::minimum_strip_width(&sep.prob);
    let mut best_sol = init_sol.clone();
    let start = Instant::now();
    let mut n_failed_attempts = 0;

    // Create the function to calculate the shrink step size.
    let shrink_step_size = |n_failed_attempts: i32| -> f32 {
        match config.shrink_decay {
            ShrinkDecayStrategy::TimeBased => {
                let range = config.shrink_range.1 - config.shrink_range.0;
                let elapsed = start.elapsed();
                let ratio = elapsed.as_secs_f32() / config.time_limit.as_secs_f32();
                config.shrink_range.0 + ratio * range
            }
            ShrinkDecayStrategy::FailureBased(r) => {
                config.shrink_range.0 * r.powi(n_failed_attempts)
            }
        }
    };

    // As long as the shrink step size is above the minimum, keep attempting to compress
    while !term.kill() && let step = shrink_step_size(n_failed_attempts) && step >= config.shrink_range.1 {
        let width = best_sol.strip_width();
        let next_width = width * (1.0 - step);
        if next_width < min_width || next_width >= width {
            info!("[CMPR] stopping at minimum strip width: {:.3}", min_width);
            break;
        }
        sol_listener.report_compression_progress(step);
        match attempt_to_compress(sep, &best_sol, step, term, sol_listener) {
            Some(compacted_sol) => {
                info!("[CMPR] success at {:.3}% ({:.3} | {:.3}%)", step * 100.0, compacted_sol.strip_width(), compacted_sol.density(instance) * 100.0);
                sol_listener.report(ReportType::CmprFeas, &compacted_sol, instance);
                best_sol = compacted_sol;
            }
            None => {
                info!("[CMPR] failed at {:.3}%", step * 100.0);
                n_failed_attempts += 1;
            }
        }
    }
    info!("[CMPR] finished, compressed from {:.3}% to {:.3}% (+{:.3}%)", init_sol.density(instance) * 100.0, best_sol.density(instance) * 100.0, (best_sol.density(instance) - init_sol.density(instance)) * 100.0);
    best_sol
}


fn attempt_to_compress(sep: &mut Separator, init_sol: &SPSolution, r_shrink: f32, term: &impl Terminator, sol_listener: &mut impl SolutionListener) -> Option<SPSolution> {
    // Restore to the initial solution and width
    sep.change_strip_width(init_sol.strip_width(), None);
    sep.rollback(init_sol, None);

    // Shrink the container by the provided amount at a random position
    let new_width = init_sol.strip_width() * (1.0 - r_shrink);
    let split_pos = sep.rng.random_range(0.0..sep.prob.strip_width());
    sep.change_strip_width(new_width, Some(split_pos));

    // Try to separate layout, if all collisions are eliminated, return the solution
    let (compacted_sol, ot) = sep.separate(term, sol_listener);
    match ot.get_total_loss() == 0.0 {
        true => Some(compacted_sol),
        false => None,
    }
}
