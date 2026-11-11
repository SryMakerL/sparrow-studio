use super::*;
use jagua_rs::geometry::{Transformation, geo_enums::RotationRange, geo_traits::TransformableFrom};
use jagua_rs::probs::spp::entities::SPProblem;
use rand::Rng;
use sparrow::optimizer::{
    compress::compression_phase, explore::exploration_phase, separator::Separator,
};
use sparrow::util::listener::OptimizationPhase;

struct PhaseTerminator<'a, T> {
    parent: &'a T,
    deadline: Instant,
}
impl<T: Terminator> Terminator for PhaseTerminator<'_, T> {
    fn kill(&self) -> bool {
        Instant::now() >= self.deadline || self.parent.kill()
    }
    fn new_timeout(&mut self, _: Duration) {}
    fn timeout_at(&self) -> Option<Instant> {
        Some(self.deadline)
    }
}

fn lower_bound(problem: &SPProblem) -> f32 {
    let container = problem.layout.container.outer_cd.bbox;
    let inset = problem.strip_width() - container.width();
    let area: f64 = problem
        .instance
        .items
        .iter()
        .map(|(item, qty)| f64::from(item.shape_cd.area) * *qty as f64)
        .sum();
    let mut bound = (area / f64::from(container.height())) as f32;
    for (item, qty) in &problem.instance.items {
        if *qty == 0 {
            continue;
        }
        let rotations = match &item.allowed_rotation {
            RotationRange::None => &[0.0][..],
            RotationRange::Discrete(rotations) => rotations.as_slice(),
            RotationRange::Continuous => continue,
        };
        let mut shape = item.shape_cd.as_ref().clone();
        let width = rotations
            .iter()
            .filter_map(|&rotation| {
                let bbox = shape
                    .transform_from(
                        item.shape_cd.as_ref(),
                        &Transformation::from_rotation(rotation),
                    )
                    .bbox;
                (bbox.height() <= container.height() + item.shape_cd.diameter * 1e-6)
                    .then_some((bbox.width() - item.shape_cd.diameter * 1e-6).max(0.0))
            })
            .fold(f32::INFINITY, f32::min);
        bound = bound.max(width);
    }
    bound + inset
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run(
    instance: &SPInstance,
    mut best: SPSolution,
    seed: u64,
    config: &SparrowConfig,
    exploration_deadline: Instant,
    deadline: Instant,
    terminator: &impl Terminator,
    listener: &mut impl SolutionListener,
) {
    let mut rng = Xoshiro256PlusPlus::seed_from_u64(seed);
    let mut problem = SPProblem::new(instance.clone());
    problem.restore(&best);
    let bound = lower_bound(&problem);
    for exploration in [true, false] {
        let phase_deadline = if exploration {
            exploration_deadline.min(deadline)
        } else {
            deadline
        };
        let term = PhaseTerminator {
            parent: terminator,
            deadline: phase_deadline,
        };
        listener.report_phase(if exploration {
            OptimizationPhase::Exploration
        } else {
            OptimizationPhase::Compression
        });
        while !term.kill() {
            let gap = best.strip_width() - bound;
            if gap <= best.strip_width().abs().max(1.0) * 2e-6 {
                listener.report(ReportType::Final, &best, instance);
                return;
            }
            let max_shrink = (gap / best.strip_width() * 0.5).min(0.5);
            let mut problem = SPProblem::new(instance.clone());
            problem.restore(&best);
            if term.kill() {
                break;
            }
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
            if term.kill() {
                break;
            }
            if exploration {
                let mut phase = config.expl_cfg;
                phase.time_limit = phase_deadline.saturating_duration_since(Instant::now());
                phase.shrink_step = phase.shrink_step.min(max_shrink);
                let solutions =
                    exploration_phase(instance, &mut separator, listener, &term, &phase);
                best = solutions.last().unwrap().clone();
            } else {
                let mut phase = config.cmpr_cfg;
                phase.time_limit = phase_deadline.saturating_duration_since(Instant::now());
                phase.shrink_range.0 = phase.shrink_range.0.min(max_shrink);
                phase.shrink_range.1 = phase.shrink_range.1.min(phase.shrink_range.0);
                best = compression_phase(instance, &mut separator, &best, listener, &term, &phase);
            }
        }
    }
    listener.report(ReportType::Final, &best, instance);
}
