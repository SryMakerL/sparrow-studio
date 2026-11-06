use crate::config::*;
use crate::consts::LBF_SAMPLE_CONFIG;
use crate::optimizer::compress::compression_phase;
use crate::optimizer::explore::exploration_phase;
use crate::optimizer::lbf::{ConstructionError, LBFBuilder};
use crate::optimizer::separator::Separator;
use crate::util::listener::{OptimizationPhase, ReportType, SolutionListener};
use crate::util::terminator::Terminator;
use jagua_rs::geometry::geo_enums::RotationRange;
use jagua_rs::geometry::geo_traits::TransformableFrom;
use jagua_rs::geometry::Transformation;
use jagua_rs::probs::spp::entities::{SPInstance, SPProblem, SPSolution};
use log::info;
use rand::{Rng, SeedableRng};
use std::time::Duration;
use rand::rngs::Xoshiro256PlusPlus;

pub mod lbf;
pub mod separator;
mod worker;
pub mod explore;
pub mod compress;

/// Algorithm 11 from https://doi.org/10.48550/arXiv.2509.13329
///
/// Returns a construction error if no initial solution is supplied and the
/// initial-placement heuristic cannot build one within its strip growth limit.
pub fn optimize(
    instance: SPInstance,
    mut rng: Xoshiro256PlusPlus,
    sol_listener: &mut impl SolutionListener,
    terminator: &mut impl Terminator,
    expl_config: &ExplorationConfig,
    cmpr_config: &CompressionConfig,
    initial_solution: Option<&SPSolution>
) -> Result<SPSolution, ConstructionError> {
    let mut next_rng = || Xoshiro256PlusPlus::seed_from_u64(rng.next_u64());
    
    // First build an initial solution if none is provided
    let start_prob = match initial_solution {
        None => {
            let builder = LBFBuilder::new(instance.clone(), next_rng(), LBF_SAMPLE_CONFIG).construct()?;
            builder.prob
        }
        Some(init_sol) => {
            info!("[OPT] warm starting from provided initial solution");
            let mut prob = jagua_rs::probs::spp::entities::SPProblem::new(instance.clone());
            prob.restore(init_sol);
            prob
        }
    };

    // Begin by executing the exploration phase
    sol_listener.report_phase(OptimizationPhase::Exploration);
    sol_listener.report(ReportType::ExplFeas, &start_prob.save(), &instance);
    terminator.new_timeout(expl_config.time_limit);
    let mut expl_separator = Separator::new(instance.clone(), start_prob, next_rng(), expl_config.separator_config);
    let solutions = exploration_phase(
        &instance,
        &mut expl_separator,
        sol_listener,
        terminator,
        expl_config,
    );
    let final_explore_sol = solutions.last().unwrap().clone();

    // Start the compression phase from the final solution from the exploration phase
    sol_listener.report_phase(OptimizationPhase::Compression);
    terminator.new_timeout(cmpr_config.time_limit);
    let mut cmpr_separator = Separator::new(expl_separator.instance, expl_separator.prob, next_rng(), cmpr_config.separator_config);
    let cmpr_sol = compression_phase(
        &instance,
        &mut cmpr_separator,
        &final_explore_sol,
        sol_listener,
        terminator,
        cmpr_config,
    );

    sol_listener.report(ReportType::Final, &cmpr_sol, &instance);

    // Return the final compressed solution
    Ok(cmpr_sol)
}

/// Necessary width for the collision geometry, including the container's inset.
/// Leave relative slack for f32 rotation and bounding-box rounding near exact fits.
fn minimum_strip_width(prob: &SPProblem) -> f32 {
    const REL_TOL: f32 = 1e-6;
    let container = prob.layout.container.outer_cd.bbox;
    let width_inset = prob.strip_width() - container.width();
    let area: f64 = prob.instance.items.iter()
        .map(|(item, qty)| f64::from(item.shape_cd.area) * *qty as f64)
        .sum();
    let mut min_width = (area / f64::from(container.height())) as f32 * (1.0 - REL_TOL);

    for (item, quantity) in &prob.instance.items {
        if *quantity == 0 {
            continue;
        }
        let rotations = match &item.allowed_rotation {
            RotationRange::None => &[0.0][..],
            RotationRange::Discrete(rotations) => rotations.as_slice(),
            // ponytail: continuous rotations use only the area bound; add exact rotational bounds if this is too weak.
            RotationRange::Continuous => continue,
        };
        let tolerance = item.shape_cd.diameter * REL_TOL;
        let mut shape = item.shape_cd.as_ref().clone();
        let item_width = rotations.iter()
            .filter_map(|&rotation| {
                let bbox = shape.transform_from(item.shape_cd.as_ref(), &Transformation::from_rotation(rotation)).bbox;
                (bbox.height() <= container.height() + tolerance)
                    .then_some((bbox.width() - tolerance).max(0.0))
            })
            .fold(f32::INFINITY, f32::min);
        min_width = min_width.max(item_width);
    }
    min_width + width_inset
}

#[cfg(test)]
mod rearrange_tests {
    use super::*;
    use crate::optimizer::explore::rearrange;
    use crate::util::listener::{SeparationResult, SolutionListener};
    use crate::util::terminator::BasicTerminator;
    use jagua_rs::entities::Item;
    use jagua_rs::geometry::{DTransformation, OriginalShape, primitives::Rect,
        shape_modification::{ShapeModifyConfig, ShapeModifyMode}};
    use jagua_rs::probs::spp::entities::{SPPlacement, Strip};
    use jagua_rs::Instant;
    use std::cell::Cell;

    fn separator(quantity: usize) -> Separator {
        let config = DEFAULT_SPARROW_CONFIG;
        let item = |id, width| Item::new(id, OriginalShape {
            shape: Rect::try_new(0.0, 0.0, width, 4.0).unwrap().into(),
            pre_transform: DTransformation::empty(),
            modify_mode: ShapeModifyMode::Inflate,
            modify_config: ShapeModifyConfig::default(),
        }, RotationRange::None, None, config.cde_config.item_surrogate_config).unwrap();
        let instance = SPInstance::new(vec![(item(0, 4.0), quantity), (item(1, 9.0), 0)],
            Strip::new(10.0, config.cde_config, ShapeModifyConfig::default(), 4.000001).unwrap());
        let mut problem = SPProblem::new(instance.clone());
        for i in 0..quantity {
            problem.place_item(SPPlacement { item_id: 0,
                d_transf: DTransformation::new(0.0, (0.0000005, 0.5 + i as f32 * 4.5)) });
        }
        assert!(problem.layout.is_feasible());
        let mut sep_config = config.expl_cfg.separator_config;
        sep_config.n_workers = 1;
        Separator::new(instance, problem, Xoshiro256PlusPlus::seed_from_u64(42), sep_config)
    }

    #[derive(Default)]
    struct Counter { evaluations: usize, reports: usize }
    impl SolutionListener for Counter {
        fn report(&mut self, _: ReportType, _: &SPSolution, _: &SPInstance) { self.reports += 1; }
        fn report_separation_result(&mut self, result: SeparationResult) {
            self.evaluations += result.total_evals;
        }
    }

    #[test]
    fn single_and_identical_items_search_until_deadline_without_publishing() {
        for quantity in [1, 2] {
            let mut sep = separator(quantity);
            let initial = sep.prob.save();
            let deadline = Instant::now() + Duration::from_millis(40);
            let term = BasicTerminator { timeout: Some(deadline) };
            let mut listener = Counter::default();
            let result = rearrange(&mut sep, &initial, &mut listener, &term);
            assert!(Instant::now() >= deadline);
            assert!(listener.evaluations > 0);
            assert_eq!(listener.reports, 0);
            assert_eq!(result.strip_width(), initial.strip_width());
            assert_eq!(result.layout_snapshot.placed_items.len(), quantity);
            assert!(sep.prob.layout.is_feasible());
            assert_eq!(sep.ct.get_total_loss(), 0.0);
        }
    }

    #[test]
    fn cancellation_keeps_feasible_fallback() {
        struct Signal(Cell<bool>);
        impl Terminator for Signal {
            fn kill(&self) -> bool { self.0.get() }
            fn new_timeout(&mut self, _: Duration) {}
            fn timeout_at(&self) -> Option<Instant> { None }
        }
        struct CancelListener<'a> { signal: &'a Cell<bool>, evaluations: usize }
        impl SolutionListener for CancelListener<'_> {
            fn report(&mut self, _: ReportType, _: &SPSolution, _: &SPInstance) {
                panic!("intermediate solution published");
            }
            fn report_separation_result(&mut self, result: SeparationResult) {
                self.evaluations += result.total_evals;
                self.signal.set(true);
            }
        }
        let mut sep = separator(1);
        let initial = sep.prob.save();
        let term = Signal(Cell::new(false));
        let mut listener = CancelListener { signal: &term.0, evaluations: 0 };
        let result = rearrange(&mut sep, &initial, &mut listener, &term);
        assert!(term.kill());
        assert!(listener.evaluations > 0);
        assert_eq!(result.strip_width(), initial.strip_width());
        assert!(sep.prob.layout.is_feasible());
        let before = format!("{:?}", sep.prob.layout.placed_items);
        rearrange(&mut sep, &result, &mut listener, &term);
        assert_eq!(format!("{:?}", sep.prob.layout.placed_items), before);
    }

    #[test]
    fn minimum_width_ignores_zero_demand_item() {
        let sep = separator(1);
        let bound = minimum_strip_width(&sep.prob);
        assert!(bound > 3.99 && bound <= 4.0, "{bound}");
    }
}
