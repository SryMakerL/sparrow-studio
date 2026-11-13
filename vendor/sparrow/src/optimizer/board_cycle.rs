use crate::config::SparrowConfig;
use crate::optimizer::{
    board_evacuation::evacuate_boards, board_local::compact_board_sparrow,
    compress::compression_phase, explore::exploration_phase, separator::Separator,
};
use crate::sample::board_sampler::contains_in_board;
use crate::util::listener::{OptimizationPhase, ReportType, SolutionListener};
use crate::util::terminator::Terminator;
use jagua_rs::Instant;
use jagua_rs::probs::spp::entities::{SPInstance, SPProblem, SPSolution};
use rand::{Rng, SeedableRng, rngs::Xoshiro256PlusPlus};
use std::time::Duration;

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct BoardCycleBudget {
    pub local_ms: u64,
    pub global_ms: u64,
    pub evacuation_ms: u64,
    pub local_percent: u32,
    pub global_percent: u32,
    pub evacuation_percent: u32,
    pub max_rounds: usize,
    pub stall_rounds: usize,
}

impl Default for BoardCycleBudget {
    fn default() -> Self {
        Self {
            local_ms: 10_000,
            global_ms: 10_000,
            evacuation_ms: 3_000,
            local_percent: 60,
            global_percent: 60,
            evacuation_percent: 25,
            max_rounds: 0,
            stall_rounds: 0,
        }
    }
}

impl BoardCycleBudget {
    pub fn validate(&self) -> Result<(), &'static str> {
        if [self.local_ms, self.global_ms, self.evacuation_ms]
            .iter()
            .any(|v| !(1..=600_000).contains(v))
            || [
                self.local_percent,
                self.global_percent,
                self.evacuation_percent,
            ]
            .iter()
            .any(|v| !(1..=100).contains(v))
            || self.max_rounds > 100_000
            || self.stall_rounds > 100_000
        {
            return Err(
                "Invalid board cycle budget: milliseconds 1..600000, percentages 1..100, rounds 0..100000",
            );
        }
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct BudgetInput {
    #[serde(default)]
    board_cycle: BoardCycleBudget,
}

pub fn parse_board_cycle_budget(input: &str) -> Result<BoardCycleBudget, String> {
    let parsed: BudgetInput = serde_json::from_str(input).map_err(|error| error.to_string())?;
    parsed.board_cycle.validate().map_err(str::to_owned)?;
    Ok(parsed.board_cycle)
}
type BoardState = Vec<(usize, u32, u32, u32)>;

struct Slice<'a, T> {
    parent: &'a T,
    deadline: Instant,
}
impl<T: Terminator> Terminator for Slice<'_, T> {
    fn kill(&self) -> bool {
        Instant::now() >= self.deadline || self.parent.kill()
    }
    fn new_timeout(&mut self, _: Duration) {}
    fn timeout_at(&self) -> Option<Instant> {
        Some(self.deadline)
    }
}

fn board_states(instance: &SPInstance, solution: &SPSolution) -> Option<Vec<BoardState>> {
    let boards = &instance.stock_constraints.as_ref()?.boards;
    let mut states = vec![Vec::new(); boards.len()];
    for placed in solution.layout_snapshot.placed_items.values() {
        let bbox = placed.shape.bbox;
        let index = boards.iter().position(|board| {
            let outer = board.outer.bbox;
            bbox.x_min >= outer.x_min
                && bbox.x_max <= outer.x_max
                && bbox.y_min >= outer.y_min
                && bbox.y_max <= outer.y_max
                && contains_in_board(board, &placed.shape)
        })?;
        let dt = placed.d_transf;
        let (x, y) = dt.translation();
        states[index].push((
            placed.item_id,
            dt.rotation().to_bits(),
            x.to_bits(),
            y.to_bits(),
        ));
    }
    for state in &mut states {
        state.sort_unstable();
    }
    Some(states)
}

fn score(instance: &SPInstance, solution: &SPSolution) -> (usize, f32, f32) {
    let Some(stock) = &instance.stock_constraints else {
        return (usize::MAX, f32::INFINITY, f32::INFINITY);
    };
    let mut lengths = vec![None::<f32>; stock.boards.len()];
    for placed in solution.layout_snapshot.placed_items.values() {
        let bbox = placed.shape.bbox;
        let Some(index) = stock.boards.iter().position(|board| {
            let outer = board.outer.bbox;
            bbox.x_min >= outer.x_min
                && bbox.x_max <= outer.x_max
                && bbox.y_min >= outer.y_min
                && bbox.y_max <= outer.y_max
        }) else {
            return (usize::MAX, f32::INFINITY, f32::INFINITY);
        };
        let length = bbox.x_max - stock.boards[index].outer.bbox.x_min;
        lengths[index] = Some(lengths[index].unwrap_or(0.0).max(length));
    }
    (
        lengths.iter().filter(|v| v.is_some()).count(),
        lengths.iter().flatten().sum(),
        solution.strip_width(),
    )
}

fn better(instance: &SPInstance, left: &SPSolution, right: &SPSolution) -> bool {
    let a = score(instance, left);
    let b = score(instance, right);
    a.0 < b.0 || (a.0 == b.0 && (a.1 < b.1 || (a.1 == b.1 && a.2 < b.2)))
}

/// Alternates warm board-local compaction with bounded global search and evacuation.
/// Local working snapshots survive even when the outer rectangle does not shorten.
pub fn alternate_boards(
    instance: &SPInstance,
    initial: &SPSolution,
    seed: u64,
    config: &SparrowConfig,
    deadline: Instant,
    term: &impl Terminator,
    listener: &mut impl SolutionListener,
) -> SPSolution {
    alternate_boards_with_budget(
        instance,
        initial,
        seed,
        config,
        &BoardCycleBudget::default(),
        deadline,
        term,
        listener,
    )
}

pub fn alternate_boards_with_budget(
    instance: &SPInstance,
    initial: &SPSolution,
    seed: u64,
    config: &SparrowConfig,
    budget: &BoardCycleBudget,
    deadline: Instant,
    term: &impl Terminator,
    listener: &mut impl SolutionListener,
) -> SPSolution {
    alternate_boards_until(
        instance,
        initial,
        seed,
        config,
        budget,
        Some(deadline),
        term,
        listener,
    )
}

pub fn alternate_boards_until(
    instance: &SPInstance,
    initial: &SPSolution,
    seed: u64,
    config: &SparrowConfig,
    budget: &BoardCycleBudget,
    deadline: Option<Instant>,
    term: &impl Terminator,
    listener: &mut impl SolutionListener,
) -> SPSolution {
    if budget.validate().is_err() {
        return initial.clone();
    }
    let Some(states) = board_states(instance, initial) else {
        return initial.clone();
    };
    if states.len() < 2 || term.kill() {
        return initial.clone();
    }
    let mut rng = Xoshiro256PlusPlus::seed_from_u64(seed);
    let mut work = initial.clone();
    let mut best = initial.clone();
    let mut processed: Vec<Option<BoardState>> = vec![None; states.len()];
    let mut stagnant = 0;
    let mut round = 0usize;
    loop {
        if budget.max_rounds > 0 && round >= budget.max_rounds {
            break;
        }
        if term.kill() || deadline.is_some_and(|end| Instant::now() >= end) {
            break;
        }
        let before = score(instance, &work);
        let Some(states) = board_states(instance, &work) else {
            break;
        };
        let last_occupied = states.iter().rposition(|state| !state.is_empty());
        let dirty: Vec<_> = states
            .iter()
            .enumerate()
            .filter(|(index, state)| {
                Some(*index) != last_occupied
                    && !state.is_empty()
                    && processed[*index].as_ref() != Some(*state)
            })
            .map(|(index, _)| index)
            .collect();
        let local_cap = Duration::from_millis(budget.local_ms);
        let per_board = deadline.map_or(local_cap, |end| {
            end.saturating_duration_since(Instant::now())
                .mul_f64(f64::from(budget.local_percent) / 100.0)
                .div_f64(dirty.len().max(1) as f64)
                .min(local_cap)
        });
        for index in dirty {
            if term.kill() || deadline.is_some_and(|end| Instant::now() >= end) {
                break;
            }
            let local_term = Slice {
                parent: term,
                deadline: deadline.map_or(Instant::now() + per_board, |end| {
                    end.min(Instant::now() + per_board)
                }),
            };
            listener.report_board_phase(index, OptimizationPhase::Exploration);
            let mut local_config = *config;
            local_config.expl_cfg.time_limit = per_board.mul_f64(0.76);
            local_config.cmpr_cfg.time_limit = per_board.mul_f64(0.19);
            let candidate = compact_board_sparrow(
                instance,
                &work,
                index,
                &mut rng,
                &local_term,
                &local_config,
                listener,
            );
            if candidate.layout_snapshot.placed_items.len()
                == initial.layout_snapshot.placed_items.len()
            {
                work = candidate;
            }
            if let Some(states) = board_states(instance, &work) {
                processed[index] = Some(states[index].clone());
            }
            if better(instance, &work, &best) {
                best = work.clone();
            }
            listener.report(ReportType::CmprFeas, &work, instance);
        }
        if term.kill() || deadline.is_some_and(|end| Instant::now() >= end) {
            break;
        }
        let global_cap = Duration::from_millis(budget.global_ms);
        let global_budget = deadline.map_or(global_cap, |end| {
            end.saturating_duration_since(Instant::now())
                .mul_f64(f64::from(budget.global_percent) / 100.0)
                .min(global_cap)
        });
        let global_term = Slice {
            parent: term,
            deadline: deadline.map_or(Instant::now() + global_budget, |end| {
                end.min(Instant::now() + global_budget)
            }),
        };
        let exploration = round % 2 == 0;
        listener.report_phase(if exploration {
            OptimizationPhase::Exploration
        } else {
            OptimizationPhase::Compression
        });
        let mut problem = SPProblem::new(instance.clone());
        problem.restore(&work);
        let separator_config = if exploration {
            config.expl_cfg.separator_config
        } else {
            config.cmpr_cfg.separator_config
        };
        let mut separator = Separator::new(
            instance.clone(),
            problem,
            Xoshiro256PlusPlus::seed_from_u64(rng.next_u64()),
            separator_config,
        );
        let mut reports = FeasibleReports {
            instance,
            work: work.clone(),
            best: best.clone(),
            listener,
        };
        if !global_term.kill() {
            if exploration {
                let mut phase = config.expl_cfg;
                phase.time_limit = global_budget;
                exploration_phase(instance, &mut separator, &mut reports, &global_term, &phase);
            } else {
                let mut phase = config.cmpr_cfg;
                phase.time_limit = global_budget;
                compression_phase(
                    instance,
                    &mut separator,
                    &work,
                    &mut reports,
                    &global_term,
                    &phase,
                );
            }
        }
        work = reports.work;
        best = reports.best;
        if term.kill() || deadline.is_some_and(|end| Instant::now() >= end) {
            break;
        }
        let evacuation_cap = Duration::from_millis(budget.evacuation_ms);
        let evacuation_budget = deadline.map_or(evacuation_cap, |end| {
            end.saturating_duration_since(Instant::now())
                .mul_f64(f64::from(budget.evacuation_percent) / 100.0)
                .min(evacuation_cap)
        });
        let evacuation_term = Slice {
            parent: term,
            deadline: deadline.map_or(Instant::now() + evacuation_budget, |end| {
                end.min(Instant::now() + evacuation_budget)
            }),
        };
        listener.report_board_evacuation();
        work = evacuate_boards(instance, &work, &mut rng, &evacuation_term, listener);
        if better(instance, &work, &best) {
            best = work.clone();
        }
        let after = score(instance, &work);
        if after.0 < before.0
            || (after.0 == before.0
                && (after.1 < before.1 || (after.1 == before.1 && after.2 < before.2)))
        {
            stagnant = 0;
        } else {
            stagnant += 1;
        }
        round += 1;
        if budget.stall_rounds > 0 && stagnant >= budget.stall_rounds {
            break;
        }
    }
    best
}

struct FeasibleReports<'a, L> {
    instance: &'a SPInstance,
    work: SPSolution,
    best: SPSolution,
    listener: &'a mut L,
}
impl<L: SolutionListener> SolutionListener for FeasibleReports<'_, L> {
    fn report(&mut self, report: ReportType, solution: &SPSolution, instance: &SPInstance) {
        if matches!(
            report,
            ReportType::ExplFeas | ReportType::CmprFeas | ReportType::Final
        ) && solution.layout_snapshot.placed_items.len()
            == self.work.layout_snapshot.placed_items.len()
            && self
                .instance
                .matches_stock_constraints(&solution.stock_constraints)
            && board_states(instance, solution).is_some()
        {
            if better(instance, solution, &self.work) {
                self.work = solution.clone();
            }
            if better(instance, solution, &self.best) {
                self.best = solution.clone();
            }
        }
        self.listener.report(report, solution, instance);
    }
    fn report_phase(&mut self, phase: OptimizationPhase) {
        self.listener.report_phase(phase);
    }
    fn report_separation_progress(&mut self, p: crate::util::listener::SeparationProgress) {
        self.listener.report_separation_progress(p);
    }
    fn report_separation_result(&mut self, p: crate::util::listener::SeparationResult) {
        self.listener.report_separation_result(p);
    }
    fn report_compression_progress(&mut self, p: f32) {
        self.listener.report_compression_progress(p);
    }
}
