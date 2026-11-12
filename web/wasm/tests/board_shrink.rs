#[path = "../src/stock.rs"]
mod stock;

use jagua_rs::collision_detection::hazards::filter::NoFilter;
use jagua_rs::geometry::DTransformation;
use jagua_rs::io::import::Importer;
use jagua_rs::probs::spp::entities::{SPInstance, SPSolution};
use jagua_rs::probs::spp::entities::{SPPlacement, SPProblem};
use jagua_rs::probs::spp::io::{ext_repr::ExtSPInstance, import_instance};
use rand::{SeedableRng, rngs::Xoshiro256PlusPlus};
use serde_json::json;
use sparrow::config::DEFAULT_SPARROW_CONFIG;
use sparrow::consts::LBF_SAMPLE_CONFIG;
use sparrow::optimizer::lbf::LBFBuilder;
use sparrow::optimizer::{board_shrink::BoardShrink, separator::Separator};
use sparrow::util::listener::{ReportType, SolutionListener};
use sparrow::util::terminator::{BasicTerminator, Terminator};
use std::time::Duration;

fn problem(count: usize) -> SPProblem {
    let width = count as f32 * 101.0 - 1.0;
    let boards: Vec<_> = (0..count)
        .map(|i| {
            let x = i as f32 * 101.0;
            json!({"outer": [[x,0.0],[x+100.0,0.0],[x+100.0,50.0],[x,50.0]]})
        })
        .collect();
    let input = json!({
        "name": "adaptive shrink", "strip_height": 50,
        "items": [{"id":0, "demand":2, "allowed_orientations":[0],
            "shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":8,"height":8}}}],
        "stock_geometry": {"outer":[[0.0,0.0],[width,0.0],[width,50.0],[0.0,50.0]], "boards":boards}
    });
    let external: ExtSPInstance = serde_json::from_value(input.clone()).unwrap();
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, None, None);
    let instance = stock::apply(
        import_instance(&importer, &external).unwrap(),
        stock::parse(&input.to_string(), 50.0).unwrap(),
    )
    .unwrap();
    let mut problem = SPProblem::new(instance);
    for x in [10.0, width - 4.0] {
        problem.place_item(SPPlacement {
            item_id: 0,
            d_transf: DTransformation::new(0.0, (x, 10.0)),
        });
    }
    problem
}

#[test]
fn shrink_is_capped_by_tail_board_not_virtual_total_length() {
    for count in [2, 20] {
        let problem = problem(count);
        let policy = BoardShrink::new(&problem).unwrap();
        let step = policy.step(&problem, 0.1).unwrap();
        assert!((problem.strip_width() - step.next_width - 2.0).abs() < 0.001);
        assert_eq!(step.split_min, (count - 1) as f32 * 101.0);
        assert_eq!(step.split_max, problem.strip_width());
    }
}

#[test]
fn failed_steps_halve_and_successes_recover_gradually() {
    let problem = problem(2);
    let mut policy = BoardShrink::new(&problem).unwrap();
    let amount = |policy: &BoardShrink| {
        problem.strip_width() - policy.step(&problem, 0.1).unwrap().next_width
    };
    assert_eq!(amount(&policy), 2.0);
    policy.failed();
    assert_eq!(amount(&policy), 1.0);
    policy.succeeded();
    assert_eq!(amount(&policy), 1.25);
    for _ in 0..20 {
        policy.succeeded();
    }
    assert_eq!(amount(&policy), 2.0);
}

#[test]
fn single_physical_board_keeps_legacy_shrink_policy() {
    assert!(BoardShrink::new(&problem(1)).is_none());
}

#[test]
fn local_split_leaves_previous_boards_and_fixed_obstacles_unchanged() {
    let problem = problem(3);
    let step = BoardShrink::new(&problem)
        .unwrap()
        .step(&problem, 0.1)
        .unwrap();
    let first = problem
        .layout
        .placed_items
        .values()
        .min_by(|a, b| {
            a.d_transf
                .translation()
                .0
                .total_cmp(&b.d_transf.translation().0)
        })
        .unwrap()
        .d_transf;
    let mut config = DEFAULT_SPARROW_CONFIG.cmpr_cfg.separator_config;
    config.n_workers = 1;
    let mut sep = Separator::new(
        problem.instance.clone(),
        problem,
        Xoshiro256PlusPlus::seed_from_u64(42),
        config,
    );
    let obstacles: Vec<_> = sep
        .prob
        .instance
        .stock_constraints
        .as_ref()
        .unwrap()
        .holes
        .shapes_cd
        .iter()
        .map(|shape| shape.vertices.clone())
        .collect();
    sep.change_strip_width(
        step.next_width,
        Some((step.split_min + step.split_max) * 0.5),
    );
    assert!(
        sep.prob
            .layout
            .placed_items
            .values()
            .any(|item| item.d_transf == first)
    );
    let after: Vec<_> = sep
        .prob
        .instance
        .stock_constraints
        .as_ref()
        .unwrap()
        .holes
        .shapes_cd
        .iter()
        .map(|shape| shape.vertices.clone())
        .collect();
    assert_eq!(obstacles, after);
}

struct CheckedReports(usize);
impl SolutionListener for CheckedReports {
    fn report(&mut self, report: ReportType, solution: &SPSolution, instance: &SPInstance) {
        if !matches!(
            report,
            ReportType::ExplFeas | ReportType::CmprFeas | ReportType::Final
        ) {
            return;
        }
        let mut problem = SPProblem::new(instance.clone());
        problem.restore(solution);
        let shapes: Vec<_> = problem
            .layout
            .placed_items
            .iter()
            .map(|(key, item)| (key, item.shape.as_ref().clone()))
            .collect();
        for (key, shape) in shapes {
            let mut layout = problem.layout.clone();
            layout.remove_item(key);
            assert!(!layout.cde().detect_poly_collision(&shape, &NoFilter));
        }
        self.0 += 1;
    }
}

#[test]
fn adaptive_exploration_and_compression_publish_only_feasible_solutions() {
    let mut instance = problem(2).instance;
    instance.items[0].1 = 4;
    let built = LBFBuilder::new(
        instance.clone(),
        Xoshiro256PlusPlus::seed_from_u64(42),
        LBF_SAMPLE_CONFIG,
    )
    .construct()
    .unwrap();
    let mut config = DEFAULT_SPARROW_CONFIG;
    config.expl_cfg.separator_config.n_workers = 1;
    config.cmpr_cfg.separator_config.n_workers = 1;
    let mut sep = Separator::new(
        instance.clone(),
        built.prob,
        Xoshiro256PlusPlus::seed_from_u64(43),
        config.expl_cfg.separator_config,
    );
    let mut term = BasicTerminator::new();
    term.new_timeout(Duration::from_millis(100));
    let mut reports = CheckedReports(0);
    let solutions = sparrow::optimizer::explore::exploration_phase(
        &instance,
        &mut sep,
        &mut reports,
        &term,
        &config.expl_cfg,
    );
    let initial = solutions.last().unwrap();
    sep.change_strip_width(initial.strip_width(), None);
    sep.rollback(initial, None);
    term.new_timeout(Duration::from_millis(100));
    let result = sparrow::optimizer::compress::compression_phase(
        &instance,
        &mut sep,
        initial,
        &mut reports,
        &term,
        &config.cmpr_cfg,
    );
    assert!(result.strip_width() <= initial.strip_width());
    assert!(reports.0 > 0);
}
