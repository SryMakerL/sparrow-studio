use crate::config::{CompressionConfig, ShrinkDecayStrategy};
use crate::optimizer::separator::Separator;
use crate::util::listener::{ReportType, SolutionListener};
use crate::util::terminator::Terminator;
use jagua_rs::Instant;
use jagua_rs::probs::spp::entities::{SPInstance, SPSolution};
use log::info;
use rand::{Rng, RngExt};

/// Algorithm 13 from https://doi.org/10.48550/arXiv.2509.13329
pub fn compression_phase(
    instance: &SPInstance,
    sep: &mut Separator,
    init_sol: &SPSolution,
    sol_listener: &mut impl SolutionListener,
    term: &impl Terminator,
    config: &CompressionConfig,
) -> SPSolution {
    let min_width = super::minimum_strip_width(&sep.prob);
    let mut best_sol = init_sol.clone();
    let start = Instant::now();
    let mut n_failed_attempts = 0;
    let mut board_shrink = super::board_shrink::BoardShrink::new(&sep.prob);

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
    while !term.kill()
        && let step = shrink_step_size(n_failed_attempts)
        && step >= config.shrink_range.1
    {
        let width = best_sol.strip_width();
        if board_shrink.is_some() {
            sep.prob.restore(&best_sol);
        }
        let board_step = match &board_shrink {
            Some(policy) => match policy.step(&sep.prob, step) {
                Some(step) => Some(step),
                None => break,
            },
            None => None,
        };
        let next_width = board_step.map_or(width * (1.0 - step), |step| step.next_width);
        if next_width < min_width || next_width >= width {
            info!("[CMPR] stopping at minimum strip width: {:.3}", min_width);
            break;
        }
        let actual_step = (width - next_width) / width;
        let split_range = board_step.map(|step| (step.split_min, step.split_max));
        sol_listener.report_compression_progress(actual_step);
        match attempt_to_compress(sep, &best_sol, next_width, split_range, term, sol_listener) {
            Some(compacted_sol) => {
                info!(
                    "[CMPR] success at {:.3}% ({:.3} | {:.3}%)",
                    actual_step * 100.0,
                    compacted_sol.strip_width(),
                    compacted_sol.density(instance) * 100.0
                );
                sol_listener.report(ReportType::CmprFeas, &compacted_sol, instance);
                best_sol = compacted_sol;
                if let Some(policy) = &mut board_shrink {
                    policy.succeeded();
                }
            }
            None => {
                info!("[CMPR] failed at {:.3}%", actual_step * 100.0);
                if let Some(policy) = &mut board_shrink {
                    policy.failed();
                } else {
                    n_failed_attempts += 1;
                }
            }
        }
    }
    info!(
        "[CMPR] finished, compressed from {:.3}% to {:.3}% (+{:.3}%)",
        init_sol.density(instance) * 100.0,
        best_sol.density(instance) * 100.0,
        (best_sol.density(instance) - init_sol.density(instance)) * 100.0
    );
    best_sol
}

fn attempt_to_compress(
    sep: &mut Separator,
    init_sol: &SPSolution,
    new_width: f32,
    split_range: Option<(f32, f32)>,
    term: &impl Terminator,
    sol_listener: &mut impl SolutionListener,
) -> Option<SPSolution> {
    // Restore to the initial solution and width
    sep.change_strip_width(init_sol.strip_width(), None);
    sep.rollback(init_sol, None);

    // Shrink the container by the provided amount at a random position
    let (split_min, split_max) = split_range.unwrap_or((0.0, sep.prob.strip_width()));
    let split_pos = if split_min < split_max {
        sep.rng.random_range(split_min..split_max)
    } else {
        split_min
    };
    sep.change_strip_width(new_width, Some(split_pos));

    // Try to separate layout, if all collisions are eliminated, return the solution
    let (compacted_sol, ot) = sep.separate(term, sol_listener);
    match ot.get_total_loss() == 0.0 {
        true => Some(compacted_sol),
        false => None,
    }
}
