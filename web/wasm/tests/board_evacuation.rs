#[path = "../src/stock.rs"]
mod stock;

use jagua_rs::entities::Instance;
use jagua_rs::geometry::{DTransformation, Transformation, geo_traits::Transformable};
use jagua_rs::io::import::Importer;
use jagua_rs::probs::spp::entities::{SPInstance, SPPlacement, SPProblem, SPSolution};
use jagua_rs::probs::spp::io::{ext_repr::ExtSPInstance, import_instance};
use rand::{SeedableRng, rngs::Xoshiro256PlusPlus};
use serde_json::{Value, json};
use sparrow::config::DEFAULT_SPARROW_CONFIG;
use sparrow::eval::{
    lbf_evaluator::LBFEvaluator,
    sample_eval::{SampleEval, SampleEvaluator},
};
use sparrow::optimizer::board_evacuation::evacuate_boards;
use sparrow::util::listener::{ReportType, SolutionListener};
use sparrow::util::terminator::{BasicTerminator, Terminator};
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
    let mut input = json!({"name":"evacuation", "strip_height":100, "items":items,
        "stock_geometry":{"outer":[[0,0],[160,0],[160,100],[0,100]], "boards":boards}});
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
fn used(solution: &SPSolution, instance: &SPInstance) -> usize {
    instance
        .stock_constraints
        .as_ref()
        .unwrap()
        .boards
        .iter()
        .filter(|b| {
            solution.layout_snapshot.placed_items.values().any(|p| {
                let r = p.shape.bbox;
                let o = b.outer.bbox;
                r.x_min >= o.x_min && r.x_max <= o.x_max && r.y_min >= o.y_min && r.y_max <= o.y_max
            })
        })
        .count()
}
#[derive(Default)]
struct Listener {
    reports: usize,
}
impl SolutionListener for Listener {
    fn report(&mut self, report: ReportType, solution: &SPSolution, instance: &SPInstance) {
        assert_eq!(report, ReportType::ExplFeas);
        let mut p = SPProblem::new(instance.clone());
        p.restore(solution);
        assert!(p.layout.is_feasible());
        assert!(p.item_demand_qtys.iter().all(|&q| q == 0));
        assert!(Arc::ptr_eq(
            instance.stock_constraints.as_ref().unwrap(),
            solution.stock_constraints.as_ref().unwrap()
        ));
        self.reports += 1;
    }
}
fn run(instance: &SPInstance, initial: &SPSolution) -> (SPSolution, Listener) {
    let mut listener = Listener::default();
    let solution = evacuate_boards(
        instance,
        initial,
        &mut Xoshiro256PlusPlus::seed_from_u64(713),
        &BasicTerminator::new(),
        &mut listener,
    );
    (solution, listener)
}
fn unchanged(a: &SPSolution, b: &SPSolution) {
    assert_eq!(a.strip, b.strip);
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

#[test]
fn direct_migration_reduces_boards_and_preserves_demand_and_snapshot_identity() {
    let inst = instance(
        vec![
            rect(0, 1, 6.0, 6.0, json!([0])),
            rect(1, 2, 8.0, 8.0, json!([0])),
        ],
        vec![board(0.0, 0.0, 20.0, 20.0), board(40.0, 0.0, 60.0, 40.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 2.0, 2.0, 0.0);
    place(&mut p, 1, 50.0, 4.0, 0.0);
    place(&mut p, 1, 70.0, 4.0, 0.0);
    p.change_strip_width(90.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    let (result, listener) = run(&inst, &initial);
    assert_eq!(used(&initial, &inst), 2);
    assert_eq!(used(&result, &inst), 1);
    assert_eq!(listener.reports, 1);
    p.restore(&result);
    assert_eq!(p.item_demand_qtys, vec![0, 0]);
    assert_eq!(p.n_placed_items(), 3);
    assert!(
        p.layout
            .placed_items
            .values()
            .all(|pi| pi.shape.bbox.x_min >= 40.0)
    );
    assert!(result.strip.width >= initial.strip.width);
    for (key, before) in initial
        .layout_snapshot
        .placed_items
        .iter()
        .filter(|(_, p)| p.item_id == 1)
    {
        assert_eq!(
            result.layout_snapshot.placed_items[key].d_transf,
            before.d_transf
        );
    }
    let mut original = SPProblem::new(inst.clone());
    original.restore(&initial);
    assert_eq!(used(&original.save(), &inst), 2);
}

#[test]
fn blocked_direct_migration_succeeds_only_after_small_neighborhood_repacking() {
    let inst = instance(
        vec![
            rect(0, 1, 13.0, 18.0, json!([0])),
            rect(1, 2, 10.0, 18.0, json!([0])),
        ],
        vec![board(0.0, 0.0, 20.0, 20.0), board(40.0, 0.0, 40.0, 20.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 2.0, 1.0, 0.0);
    place(&mut p, 1, 48.0, 1.0, 0.0);
    place(&mut p, 1, 65.0, 1.0, 0.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    let source = p
        .layout
        .placed_items
        .iter()
        .find(|(_, i)| i.item_id == 0)
        .unwrap()
        .0;
    p.remove_item(source);
    // The two full-height residents leave horizontal gaps of only 8, 7 and 5.
    let item = inst.item(0);
    let bbox = item.shape_cd.bbox;
    let mut eval = LBFEvaluator::new(&p.layout, item);
    for x in 40..=67 {
        for y in 0..=2 {
            assert!(!matches!(
                eval.evaluate_sample(
                    DTransformation::new(0.0, (x as f32 - bbox.x_min, y as f32 - bbox.y_min)),
                    None
                ),
                SampleEval::Clear { .. }
            ));
        }
    }
    let (result, listener) = run(&inst, &initial);
    assert_eq!(used(&result, &inst), 1);
    assert_eq!(listener.reports, 1);
    let moved_residents = initial
        .layout_snapshot
        .placed_items
        .values()
        .filter(|i| i.item_id == 1)
        .any(|before| {
            !result
                .layout_snapshot
                .placed_items
                .values()
                .any(|after| after.item_id == 1 && before.d_transf == after.d_transf)
        });
    assert!(moved_residents);
    p.restore(&result);
    assert!(p.layout.is_feasible());
    assert_eq!(p.item_demand_qtys, vec![0, 0]);
}

#[test]
fn impossible_evacuation_rolls_back_without_losing_repeated_demand() {
    let inst = instance(
        vec![rect(0, 2, 20.0, 18.0, json!([0]))],
        vec![board(0.0, 0.0, 30.0, 20.0), board(40.0, 0.0, 30.0, 20.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 2.0, 1.0, 0.0);
    place(&mut p, 0, 42.0, 1.0, 0.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    let (result, listener) = run(&inst, &initial);
    unchanged(&initial, &result);
    assert_eq!(listener.reports, 0);
    p.restore(&result);
    assert_eq!(p.item_demand_qtys, vec![0]);
}

#[test]
fn board_holes_clearance_and_only_fitting_rotation_remain_authoritative() {
    let inst = instance(
        vec![
            rect(0, 1, 18.0, 6.0, json!([0, 90])),
            rect(1, 2, 4.0, 4.0, json!([0])),
        ],
        vec![
            board(0.0, 0.0, 30.0, 30.0),
            json!({"outer":[[40,0],[52,0],[52,65],[40,65]],
            "holes":[[[42,24],[50,24],[50,32],[42,32]]]}),
        ],
        Some(2.0),
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 3.0, 3.0, 0.0);
    place(&mut p, 1, 43.0, 42.0, 0.0);
    place(&mut p, 1, 43.0, 54.0, 0.0);
    assert!(p.layout.is_feasible());
    let initial = p.save();
    let (result, listener) = run(&inst, &initial);
    assert_eq!(used(&result, &inst), 1);
    assert_eq!(listener.reports, 1);
    p.restore(&result);
    assert!(p.layout.is_feasible());
    let migrated = p
        .layout
        .placed_items
        .values()
        .find(|i| i.item_id == 0)
        .unwrap();
    assert!((migrated.d_transf.rotation() - std::f32::consts::FRAC_PI_2).abs() < 1e-5);
    assert_eq!(
        inst.stock_constraints.as_ref().unwrap().boards[1]
            .holes
            .len(),
        1
    );
    assert_eq!(p.item_demand_qtys, vec![0, 0]);
}

struct Cancelled;
impl Terminator for Cancelled {
    fn kill(&self) -> bool {
        true
    }
    fn new_timeout(&mut self, _: Duration) {}
    fn timeout_at(&self) -> Option<jagua_rs::Instant> {
        None
    }
}
#[test]
fn already_cancelled_returns_original_without_reporting_or_consuming_rng() {
    let inst = instance(
        vec![rect(0, 2, 6.0, 6.0, json!([0]))],
        vec![board(0.0, 0.0, 20.0, 20.0), board(40.0, 0.0, 40.0, 20.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 2.0, 2.0, 0.0);
    place(&mut p, 0, 42.0, 2.0, 0.0);
    let initial = p.save();
    let mut rng = Xoshiro256PlusPlus::seed_from_u64(17);
    let mut expected = rng.clone();
    let mut listener = Listener::default();
    let result = evacuate_boards(&inst, &initial, &mut rng, &Cancelled, &mut listener);
    unchanged(&initial, &result);
    assert_eq!(listener.reports, 0);
    use rand::Rng;
    assert_eq!(rng.next_u64(), expected.next_u64());
}

struct CancelAfter(std::cell::Cell<usize>);
impl Terminator for CancelAfter {
    fn kill(&self) -> bool {
        let calls = self.0.get();
        self.0.set(calls + 1);
        calls >= 100
    }
    fn new_timeout(&mut self, _: Duration) {}
    fn timeout_at(&self) -> Option<jagua_rs::Instant> {
        None
    }
}

#[test]
fn cancellation_during_search_does_not_publish_partial_layout() {
    let inst = instance(
        vec![rect(0, 2, 20.0, 18.0, json!([0]))],
        vec![board(0.0, 0.0, 30.0, 20.0), board(40.0, 0.0, 30.0, 20.0)],
        None,
    );
    let mut p = SPProblem::new(inst.clone());
    place(&mut p, 0, 2.0, 1.0, 0.0);
    place(&mut p, 0, 42.0, 1.0, 0.0);
    let initial = p.save();
    let term = CancelAfter(std::cell::Cell::new(0));
    let mut listener = Listener::default();
    let result = evacuate_boards(
        &inst,
        &initial,
        &mut Xoshiro256PlusPlus::seed_from_u64(713),
        &term,
        &mut listener,
    );
    unchanged(&initial, &result);
    assert_eq!(listener.reports, 0);
    assert!(term.0.get() >= 100);
    assert!(term.0.get() < 120, "cancellation must stop promptly");
}

#[test]
fn single_board_and_legacy_stock_keep_existing_solution() {
    for boards in [vec![board(0.0, 0.0, 100.0, 100.0)], vec![]] {
        let inst = instance(vec![rect(0, 1, 8.0, 8.0, json!([0]))], boards, None);
        let mut p = SPProblem::new(inst.clone());
        place(&mut p, 0, 2.0, 2.0, 0.0);
        let initial = p.save();
        let (result, listener) = run(&inst, &initial);
        unchanged(&initial, &result);
        assert_eq!(listener.reports, 0);
    }
}
