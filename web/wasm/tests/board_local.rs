#[path = "../src/stock.rs"]
mod stock;

use jagua_rs::entities::Instance;
use jagua_rs::geometry::{DTransformation, Transformation, geo_traits::Transformable};
use jagua_rs::io::import::Importer;
use jagua_rs::probs::spp::entities::{SPInstance, SPPlacement, SPProblem, SPSolution};
use jagua_rs::probs::spp::io::{ext_repr::ExtSPInstance, import_instance};
use rand::{Rng, SeedableRng, rngs::Xoshiro256PlusPlus};
use serde_json::{Value, json};
use sparrow::config::{CompressionConfig, DEFAULT_SPARROW_CONFIG};
use sparrow::optimizer::board_local::{board_usage, compact_board, compact_board_sparrow};
use sparrow::util::listener::{
    OptimizationPhase, ReportType, SeparationProgress, SeparationResult, SolutionListener,
};

#[derive(Default)]
struct Observed {
    phases: Vec<OptimizationPhase>,
    separations: usize,
    colliding: usize,
    evals: usize,
    reports: usize,
}
impl SolutionListener for Observed {
    fn report(&mut self, _: ReportType, solution: &SPSolution, instance: &SPInstance) {
        assert!(instance.matches_stock_constraints(&solution.stock_constraints));
        assert!(board_usage(instance, solution).is_some());
        let mut p = SPProblem::new(instance.clone());
        p.restore(solution);
        assert!(p.layout.is_feasible());
        assert!(p.item_demand_qtys.iter().all(|&q| q == 0));
        self.reports += 1;
    }
    fn report_phase(&mut self, phase: OptimizationPhase) {
        self.phases.push(phase);
    }
    fn report_separation_progress(&mut self, progress: SeparationProgress) {
        self.separations += 1;
        self.colliding += usize::from(progress.min_loss > 0.0);
    }
    fn report_separation_result(&mut self, result: SeparationResult) {
        self.evals += result.total_evals;
    }
}
use sparrow::util::terminator::{BasicTerminator, Terminator};
use std::cell::Cell;
use std::sync::Arc;
use std::time::Duration;

fn rect(id: usize, qty: usize, w: f32, h: f32, angles: Value) -> Value {
    json!({"id":id, "demand":qty, "allowed_orientations":angles,
        "shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":w,"height":h}}})
}

fn board(x: f32, y: f32, w: f32, h: f32) -> Value {
    json!({"outer":[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]})
}

fn instance(items: Vec<Value>, boards: Vec<Value>, clearance: Option<f32>) -> SPInstance {
    instance_width(items, boards, clearance, 160.0)
}

fn instance_width(
    items: Vec<Value>,
    boards: Vec<Value>,
    clearance: Option<f32>,
    width: f32,
) -> SPInstance {
    let mut input = json!({"name":"board-local", "strip_height":100, "items":items,
        "stock_geometry":{"outer":[[0,0],[width,0],[width,100],[0,100]], "boards":boards}});
    if boards.is_empty() {
        input["stock_geometry"]
            .as_object_mut()
            .unwrap()
            .remove("boards");
    }
    let external: ExtSPInstance = serde_json::from_value(input.clone()).unwrap();
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, clearance, None);
    stock::apply(
        import_instance(&importer, &external).unwrap(),
        stock::parse(&input.to_string(), 100.0).unwrap(),
    )
    .unwrap()
}

fn place(problem: &mut SPProblem, id: usize, x: f32, y: f32, rotation: f32) {
    let bbox = problem
        .instance
        .item(id)
        .shape_cd
        .transform_clone(&Transformation::from_rotation(rotation))
        .bbox;
    problem.place_item(SPPlacement {
        item_id: id,
        d_transf: DTransformation::new(rotation, (x - bbox.x_min, y - bbox.y_min)),
    });
}

fn config() -> CompressionConfig {
    let mut config = DEFAULT_SPARROW_CONFIG.cmpr_cfg;
    config.time_limit = Duration::from_secs(3);
    config.separator_config.iter_no_imprv_limit = 4;
    config.separator_config.sample_config.n_container_samples = 8;
    config.separator_config.sample_config.n_focussed_samples = 8;
    config
}

fn run(instance: &SPInstance, initial: &SPSolution, index: usize) -> SPSolution {
    let mut cfg = DEFAULT_SPARROW_CONFIG;
    cfg.expl_cfg.time_limit = Duration::from_millis(2400);
    cfg.expl_cfg.shrink_step = 0.08;
    cfg.expl_cfg.separator_config = config().separator_config;
    cfg.cmpr_cfg = config();
    cfg.cmpr_cfg.shrink_range = (0.05, 0.00001);
    cfg.cmpr_cfg.time_limit = Duration::from_millis(600);
    let mut observed = Observed::default();
    let result = compact_board_sparrow(
        instance,
        initial,
        index,
        &mut Xoshiro256PlusPlus::seed_from_u64(713),
        &BasicTerminator::new(),
        &cfg,
        &mut observed,
    );
    result
}

fn unchanged(a: &SPSolution, b: &SPSolution) {
    assert_eq!(a.strip, b.strip);
    assert_eq!(a.time_stamp, b.time_stamp);
    assert_eq!(
        a.layout_snapshot.placed_items.len(),
        b.layout_snapshot.placed_items.len()
    );
    for (key, item) in &a.layout_snapshot.placed_items {
        let other = &b.layout_snapshot.placed_items[key];
        assert_eq!(item.item_id, other.item_id);
        assert_eq!(item.d_transf, other.d_transf);
    }
    assert!(Arc::ptr_eq(
        a.stock_constraints.as_ref().unwrap(),
        b.stock_constraints.as_ref().unwrap()
    ));
}

fn validate(instance: &SPInstance, initial: &SPSolution, result: &SPSolution, index: usize) {
    assert_eq!(initial.strip, result.strip);
    assert_eq!(
        initial.layout_snapshot.placed_items.len(),
        result.layout_snapshot.placed_items.len()
    );
    assert!(Arc::ptr_eq(
        instance.stock_constraints.as_ref().unwrap(),
        result.stock_constraints.as_ref().unwrap()
    ));
    assert!(Arc::ptr_eq(
        &initial.layout_snapshot.container.outer_cd,
        &result.layout_snapshot.container.outer_cd
    ));
    assert!(Arc::ptr_eq(
        &initial.layout_snapshot.container.base_cde,
        &result.layout_snapshot.container.base_cde
    ));
    let before = board_usage(instance, initial).unwrap();
    let after = board_usage(instance, result).unwrap();
    for i in 0..before.len() {
        assert_eq!(before[i].keys.len(), after[i].keys.len());
        if i == index {
            continue;
        }
        assert_eq!(before[i], after[i]);
        for &key in &before[i].keys {
            let a = &initial.layout_snapshot.placed_items[key];
            let b = &result.layout_snapshot.placed_items[key];
            assert_eq!(a.item_id, b.item_id);
            assert_eq!(a.d_transf, b.d_transf);
            assert!(Arc::ptr_eq(&a.shape, &b.shape));
        }
    }
    let mut p = SPProblem::new(instance.clone());
    p.restore(result);
    assert!(p.layout.is_feasible());
    assert!(p.item_demand_qtys.iter().all(|&q| q == 0));
}

#[test]
fn local_length_improves_without_changing_global_right_edge_or_other_board() {
    let inst = instance(
        vec![rect(0, 4, 6.0, 6.0, json!([0]))],
        vec![board(0.0, 0.0, 40.0, 30.0), board(80.0, 0.0, 60.0, 30.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    for (x, y) in [(12.0, 3.0), (29.0, 3.0), (90.0, 3.0), (125.0, 3.0)] {
        place(&mut p, 0, x, y, 0.0);
    }
    p.change_strip_width(140.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    let result = run(&inst, &initial, 0);
    validate(&inst, &initial, &result, 0);
    let before = board_usage(&inst, &initial).unwrap();
    let after = board_usage(&inst, &result).unwrap();
    assert!(after[0].used_length < before[0].used_length - 10.0);
    let right = |s: &SPSolution| {
        s.layout_snapshot
            .placed_items
            .values()
            .map(|p| p.shape.bbox.x_max)
            .fold(0.0, f32::max)
    };
    assert_eq!(right(&initial), right(&result));
    // The original remains independently restorable after accepting the improvement.
    p.restore(&initial);
    assert_eq!(board_usage(&inst, &p.save()).unwrap(), before);
}

#[test]
fn warm_start_preserves_all_item_ids_repeated_demands_and_board_assignments() {
    let inst = instance(
        vec![
            rect(0, 3, 5.0, 5.0, json!([0])),
            rect(1, 2, 8.0, 4.0, json!([0, 90])),
        ],
        vec![board(0.0, 0.0, 50.0, 40.0), board(80.0, 0.0, 50.0, 40.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 10.0, 3.0, 0.0);
    place(&mut p, 0, 30.0, 3.0, 0.0);
    place(&mut p, 0, 90.0, 3.0, 0.0);
    place(&mut p, 1, 30.0, 20.0, 0.0);
    place(&mut p, 1, 110.0, 3.0, 0.0);
    let initial = p.save();
    assert!(p.layout.is_feasible());
    let result = run(&inst, &initial, 0);
    validate(&inst, &initial, &result, 0);
    let counts = |s: &SPSolution| {
        let mut q = vec![0; 2];
        for p in s.layout_snapshot.placed_items.values() {
            q[p.item_id] += 1;
        }
        q
    };
    assert_eq!(counts(&initial), vec![3, 2]);
    assert_eq!(counts(&initial), counts(&result));
}

#[test]
fn holes_concave_board_and_clearance_remain_fixed_collision_authorities() {
    let inst = instance(
        vec![rect(0, 2, 5.0, 5.0, json!([0]))],
        vec![
            json!({"outer":[[20,0],[70,0],[70,45],[50,45],[50,65],[20,65]],
            "holes":[[[24,10],[40,10],[40,35],[24,35]]]}),
            board(90.0, 0.0, 50.0, 40.0),
        ],
        Some(2.0),
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 57.0, 15.0, 0.0);
    place(&mut p, 0, 110.0, 5.0, 0.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    let result = run(&inst, &initial, 0);
    validate(&inst, &initial, &result, 0);
    assert!(
        board_usage(&inst, &result).unwrap()[0].used_length
            < board_usage(&inst, &initial).unwrap()[0].used_length
    );
    for (a, b) in initial.layout_snapshot.container.quality_zones[0]
        .as_ref()
        .unwrap()
        .shapes_cd
        .iter()
        .zip(
            &result.layout_snapshot.container.quality_zones[0]
                .as_ref()
                .unwrap()
                .shapes_cd,
        )
    {
        assert!(Arc::ptr_eq(a, b));
    }
    let domain = &inst.stock_constraints.as_ref().unwrap().boards[0];
    assert_eq!(domain.holes.len(), 1);
    assert_eq!(domain.outer.bbox.x_min, 20.0);
}

#[test]
fn internal_board_edge_is_not_eroded_a_second_time() {
    let inst = instance(
        vec![rect(0, 1, 6.0, 6.0, json!([0]))],
        vec![board(40.0, 10.0, 30.0, 30.0)],
        Some(2.0),
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 55.0, 15.0, 0.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    let result = run(&inst, &initial, 0);
    validate(&inst, &initial, &result, 0);
    let min = result
        .layout_snapshot
        .placed_items
        .values()
        .next()
        .unwrap()
        .shape
        .bbox
        .x_min;
    assert!(
        min >= 40.0 && min < 41.0,
        "original complement must not gain the extra one-unit outer inset: {min}"
    );
    let mut edge = SPProblem::new(inst.clone());
    place(&mut edge, 0, 40.0001, 15.0, 0.0);
    assert!(edge.layout.is_feasible());
    let edge_initial = edge.save();
    let edge_result = run(&inst, &edge_initial, 0);
    validate(&inst, &edge_initial, &edge_result, 0);
    assert!(board_usage(&inst, &edge_result).unwrap()[0].used_length <= 8.0002);
    assert_eq!(
        result.strip.shape_modify_config,
        initial.strip.shape_modify_config
    );
}

#[test]
fn allowed_rotation_reduces_board_usage_without_changing_demand() {
    let inst = instance(
        vec![rect(0, 1, 18.0, 6.0, json!([0, 90]))],
        vec![board(0.0, 0.0, 50.0, 40.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 25.0, 5.0, 0.0);
    let initial = p.save();
    let result = run(&inst, &initial, 0);
    validate(&inst, &initial, &result, 0);
    let item = result.layout_snapshot.placed_items.values().next().unwrap();
    assert!((item.d_transf.rotation() - std::f32::consts::FRAC_PI_2).abs() < 1e-5);
    assert!(board_usage(&inst, &result).unwrap()[0].used_length < 7.0);
}

#[test]
fn fixed_nonzero_angle_is_preserved() {
    let inst = instance(
        vec![rect(0, 1, 7.0, 3.0, json!([30]))],
        vec![board(0.0, 0.0, 50.0, 40.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 30.0, 10.0, std::f32::consts::PI / 6.0);
    let initial = p.save();
    assert!(p.layout.is_feasible());
    let result = run(&inst, &initial, 0);
    validate(&inst, &initial, &result, 0);
    assert!(
        (result
            .layout_snapshot
            .placed_items
            .values()
            .next()
            .unwrap()
            .d_transf
            .rotation()
            - std::f32::consts::PI / 6.0)
            .abs()
            < 1e-5
    );
    assert!(board_usage(&inst, &result).unwrap()[0].used_length < 10.0);
}

struct CancelAfter {
    calls: Cell<usize>,
    limit: usize,
}
impl Terminator for CancelAfter {
    fn kill(&self) -> bool {
        let n = self.calls.get();
        self.calls.set(n + 1);
        n >= self.limit
    }
    fn new_timeout(&mut self, _: Duration) {}
    fn timeout_at(&self) -> Option<jagua_rs::Instant> {
        None
    }
}

#[test]
fn already_cancelled_keeps_snapshot_and_rng_unchanged() {
    let inst = instance(
        vec![rect(0, 1, 6.0, 6.0, json!([0]))],
        vec![board(0.0, 0.0, 40.0, 40.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 20.0, 5.0, 0.0);
    let initial = p.save();
    let mut rng = Xoshiro256PlusPlus::seed_from_u64(17);
    let mut expected = rng.clone();
    let result = compact_board(
        &inst,
        &initial,
        0,
        &mut rng,
        &CancelAfter {
            calls: Cell::new(0),
            limit: 0,
        },
        &config(),
    );
    unchanged(&initial, &result);
    assert_eq!(rng.next_u64(), expected.next_u64());
}

#[test]
fn intermediate_cancellation_rolls_back_completed_moves_too() {
    let inst = instance(
        vec![rect(0, 3, 6.0, 6.0, json!([0]))],
        vec![board(0.0, 0.0, 60.0, 40.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    for x in [15.0, 30.0, 45.0] {
        place(&mut p, 0, x, 5.0, 0.0);
    }
    let initial = p.save();
    for limit in [5, 15, 40] {
        let term = CancelAfter {
            calls: Cell::new(0),
            limit,
        };
        let result = compact_board(
            &inst,
            &initial,
            0,
            &mut Xoshiro256PlusPlus::seed_from_u64(17),
            &term,
            &config(),
        );
        unchanged(&initial, &result);
        assert!(term.calls.get() >= limit && term.calls.get() < limit + 30);
    }
}

#[test]
fn empty_board_missing_board_legacy_stock_and_foreign_snapshot_are_noops() {
    let inst = instance(
        vec![rect(0, 1, 6.0, 6.0, json!([0]))],
        vec![board(0.0, 0.0, 40.0, 40.0), board(80.0, 0.0, 40.0, 40.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 20.0, 5.0, 0.0);
    let initial = p.save();
    unchanged(&initial, &run(&inst, &initial, 1));
    unchanged(&initial, &run(&inst, &initial, 99));
    let foreign = instance(
        vec![rect(0, 1, 6.0, 6.0, json!([0]))],
        vec![board(0.0, 0.0, 40.0, 40.0), board(80.0, 0.0, 40.0, 40.0)],
        None,
    );
    unchanged(&initial, &run(&foreign, &initial, 0));
    assert!(board_usage(&foreign, &initial).is_none());
    let legacy = instance(vec![rect(0, 1, 6.0, 6.0, json!([0]))], vec![], None);
    let mut p = SPProblem::new(legacy.clone());
    place(&mut p, 0, 20.0, 5.0, 0.0);
    let initial = p.save();
    unchanged(&initial, &run(&legacy, &initial, 0));
    let mut unconstrained = inst.clone();
    unconstrained.stock_constraints = None;
    unchanged(&initial, &run(&unconstrained, &initial, 0));
}

#[test]
fn incomplete_or_colliding_warm_starts_are_not_rebuilt_or_repaired() {
    let inst = instance(
        vec![rect(0, 2, 6.0, 6.0, json!([0]))],
        vec![board(0.0, 0.0, 50.0, 40.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 20.0, 5.0, 0.0);
    let initial = p.save();
    unchanged(&initial, &run(&inst, &initial, 0));
    place(&mut p, 0, 20.0, 5.0, 0.0);
    assert!(!p.layout.is_feasible());
    let initial = p.save();
    unchanged(&initial, &run(&inst, &initial, 0));
}

#[test]
fn already_tight_solution_and_zero_time_budget_return_original_clone() {
    let inst = instance(
        vec![rect(0, 1, 20.0, 18.0, json!([0]))],
        vec![board(0.0, 0.0, 20.001, 20.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 0.000001, 1.0, 0.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    unchanged(&initial, &run(&inst, &initial, 0));
    let mut cfg = config();
    cfg.time_limit = Duration::ZERO;
    let result = compact_board(
        &inst,
        &initial,
        0,
        &mut Xoshiro256PlusPlus::seed_from_u64(17),
        &BasicTerminator::new(),
        &cfg,
    );
    unchanged(&initial, &result);
}

#[test]
fn continuous_warm_start_accepts_a_non_grid_angle() {
    let angle = 0.371_f32;
    let inst = instance(
        vec![rect(0, 1, 9.0, 3.0, Value::Null)],
        vec![board(20.0, 10.0, 70.0, 30.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 60.0, 15.0, angle);
    let initial = p.save();
    assert!(p.layout.is_feasible());
    let result = run(&inst, &initial, 0);
    validate(&inst, &initial, &result, 0);
    let rotation = result
        .layout_snapshot
        .placed_items
        .values()
        .next()
        .unwrap()
        .d_transf
        .rotation();
    assert!(rotation.is_finite());
    assert!(
        board_usage(&inst, &result).unwrap()[0].used_length
            < board_usage(&inst, &initial).unwrap()[0].used_length
    );
}

#[test]
fn exact_internal_board_boundary_warm_start_is_not_reinset() {
    let inst = instance(
        vec![rect(0, 1, 8.0, 8.0, json!([0]))],
        vec![board(10.0, 10.0, 30.0, 30.0), board(40.0, 10.0, 30.0, 30.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 40.0, 15.0, 0.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    let result = run(&inst, &initial, 1);
    unchanged(&initial, &result);
    assert_eq!(board_usage(&inst, &result).unwrap()[1].used_length, 8.0);
}

#[test]
fn high_coordinate_board_uses_local_normalization_without_reimporting_parts() {
    let inst = instance_width(
        vec![rect(0, 1, 2.0, 2.0, json!([0]))],
        vec![
            board(0.0, 0.0, 20.0, 20.0),
            board(200000.0, 0.0, 10.0, 20.0),
        ],
        None,
        200010.0,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 200006.0, 5.0, 0.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    let result = run(&inst, &initial, 1);
    validate(&inst, &initial, &result, 1);
    assert!(
        board_usage(&inst, &result).unwrap()[1].used_length
            < board_usage(&inst, &initial).unwrap()[1].used_length
    );
}

fn phase_config() -> sparrow::config::SparrowConfig {
    let mut cfg = DEFAULT_SPARROW_CONFIG;
    cfg.expl_cfg.time_limit = Duration::from_millis(1600);
    cfg.expl_cfg.shrink_step = 0.12;
    cfg.expl_cfg.max_conseq_failed_attempts = Some(1);
    cfg.expl_cfg.separator_config = config().separator_config;
    cfg.expl_cfg.separator_config.n_workers = 1;
    cfg.cmpr_cfg = config();
    cfg.cmpr_cfg.time_limit = Duration::from_millis(400);
    cfg.cmpr_cfg.shrink_range = (0.05, 0.00001);
    cfg.cmpr_cfg.separator_config.n_workers = 1;
    cfg
}

#[test]
fn original_phases_and_separator_rearrange_tightly_adjacent_neighbors() {
    let inst = instance(
        vec![
            rect(0, 3, 8.0, 8.0, json!([0])),
            rect(1, 1, 48.0, 3.0, json!([0])),
        ],
        vec![board(20.0, 10.0, 40.0, 30.0), board(90.0, 0.0, 60.0, 30.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    for x in [32.0, 40.001, 48.002] {
        place(&mut p, 0, x, 12.0, 0.0);
    }
    place(&mut p, 1, 95.0, 5.0, 0.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    let mut observed = Observed::default();
    let result = compact_board_sparrow(
        &inst,
        &initial,
        0,
        &mut Xoshiro256PlusPlus::seed_from_u64(713),
        &BasicTerminator::new(),
        &phase_config(),
        &mut observed,
    );
    validate(&inst, &initial, &result, 0);
    assert_eq!(
        observed.phases,
        vec![
            OptimizationPhase::Exploration,
            OptimizationPhase::Compression
        ]
    );
    assert!(observed.separations > 2 && observed.colliding > 0 && observed.evals > 0);
    assert!(observed.reports > 0);
    let usage = board_usage(&inst, &result).unwrap();
    assert!(
        usage[0].used_length < 18.0,
        "neighbors must leave their original single row: {:?}",
        usage[0]
    );
    let ys: Vec<_> = usage[0]
        .keys
        .iter()
        .map(|&k| result.layout_snapshot.placed_items[k].shape.bbox.y_min)
        .collect();
    assert!(ys.iter().any(|y| (y - ys[0]).abs() > 7.0));
}

#[test]
fn absolute_timeout_retains_validated_improvements_and_retries_do_not_reset_it() {
    let inst = instance(
        vec![rect(0, 2, 6.0, 6.0, json!([0]))],
        vec![board(20.0, 10.0, 40.0, 30.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 32.0, 15.0, 0.0);
    place(&mut p, 0, 48.0, 15.0, 0.0);
    let initial = p.save();
    let mut cfg = phase_config();
    cfg.expl_cfg.time_limit = Duration::from_millis(400);
    cfg.cmpr_cfg.time_limit = Duration::from_millis(100);
    let mut observed = Observed::default();
    let start = jagua_rs::Instant::now();
    let mut term = BasicTerminator::new();
    term.new_timeout(Duration::from_millis(500));
    let result = compact_board_sparrow(
        &inst,
        &initial,
        0,
        &mut Xoshiro256PlusPlus::seed_from_u64(713),
        &term,
        &cfg,
        &mut observed,
    );
    validate(&inst, &initial, &result, 0);
    assert!(observed.reports > 0);
    assert!(
        board_usage(&inst, &result).unwrap()[0].used_length
            < board_usage(&inst, &initial).unwrap()[0].used_length
    );
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "natural phase failures must not renew the deadline"
    );
}

#[test]
fn original_outer_rectangle_inset_survives_local_padding() {
    let inst = instance(
        vec![rect(0, 1, 6.0, 6.0, json!([0]))],
        vec![board(0.0, 0.0, 40.0, 30.0)],
        Some(2.0),
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 1.001, 1.001, 0.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    let result = run(&inst, &initial, 0);
    validate(&inst, &initial, &result, 0);
    let item = result.layout_snapshot.placed_items.values().next().unwrap();
    assert!(item.shape.bbox.x_min >= 1.0 && item.shape.bbox.y_min >= 1.0);
}
