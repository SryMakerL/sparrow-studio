#[path = "../src/stock.rs"]
mod stock;

use jagua_rs::collision_detection::hazards::filter::NoFilter;
use jagua_rs::entities::Instance;
use jagua_rs::geometry::geo_traits::Transformable;
use jagua_rs::geometry::{DTransformation, Transformation};
use jagua_rs::io::import::Importer;
use jagua_rs::probs::spp::entities::{SPBoardDomain, SPInstance, SPPlacement, SPProblem};
use jagua_rs::probs::spp::io::{ext_repr::ExtSPInstance, import_instance};
use rand::{SeedableRng, rngs::Xoshiro256PlusPlus};
use serde_json::{Value, json};
use sparrow::config::DEFAULT_SPARROW_CONFIG;
use sparrow::eval::lbf_evaluator::LBFEvaluator;
use sparrow::eval::sample_eval::{SampleEval, SampleEvaluator};
use sparrow::eval::sep_evaluator::SeparationEvaluator;
use sparrow::optimizer::lbf::LBFBuilder;
use sparrow::quantify::tracker::CollisionTracker;
use sparrow::sample::board_sampler::BoardSampler;
use sparrow::sample::search::{SampleConfig, search_placement};
use sparrow::sample::uniform_sampler::UniformBBoxSampler;
use std::cell::RefCell;
use std::sync::Arc;

fn input(w: f32, h: f32, rotations: Value, stock_geometry: Value) -> Value {
    json!({
        "name": "board sampling", "strip_height": 100,
        "items": [{"id": 0, "demand": 1, "allowed_orientations": rotations,
            "shape": {"type": "rectangle", "data": {
                "x_min": 0, "y_min": 0, "width": w, "height": h}}}],
        "stock_geometry": stock_geometry
    })
}

fn instance(input: Value) -> SPInstance {
    let external: ExtSPInstance = serde_json::from_value(input.clone()).unwrap();
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, None, None);
    stock::apply(
        import_instance(&importer, &external).unwrap(),
        stock::parse(&input.to_string(), 100.0).unwrap(),
    )
    .unwrap()
}

fn separated() -> Value {
    json!({"outer": [[0,0],[160,0],[160,100],[0,100]], "boards": [
        {"outer": [[0,0],[40,0],[40,35],[0,35]]},
        {"outer": [[120,0],[160,0],[160,100],[120,100]]}
    ]})
}

fn sample_valid(instance: &SPInstance, count: usize) -> Vec<DTransformation> {
    let problem = SPProblem::new(instance.clone());
    let item = instance.item(0);
    let boards = &instance.stock_constraints.as_ref().unwrap().boards;
    let bbox = problem.layout.container.outer_cd.bbox;
    let mut sampler = BoardSampler::new(boards, item, bbox, bbox).unwrap();
    let mut rng = Xoshiro256PlusPlus::seed_from_u64(713);
    (0..count)
        .filter_map(|_| {
            sampler.sample(boards, item, &mut rng).map(|dt| {
                let shape = item.shape_cd.transform_clone(&dt.compose());
                assert!(
                    !problem
                        .layout
                        .cde()
                        .detect_poly_collision(&shape, &NoFilter),
                    "sample {dt:?}"
                );
                dt
            })
        })
        .collect()
}

#[test]
fn positive_seams_and_unequal_heights_never_receive_board_samples() {
    let inst = instance(input(8.0, 8.0, json!([0]), separated()));
    let samples = sample_valid(&inst, 600);
    assert_eq!(samples.len(), 600);
    let mut visits = [0; 2];
    for dt in samples {
        let bbox = inst.item(0).shape_cd.transform_clone(&dt.compose()).bbox;
        if bbox.x_max <= 40.0 {
            assert!(bbox.y_max <= 35.0);
            visits[0] += 1;
        } else {
            assert!(bbox.x_min >= 120.0 && bbox.y_max <= 100.0);
            visits[1] += 1;
        }
    }
    assert!(visits.iter().all(|n| *n > 150));
}

#[test]
fn concave_contour_and_irregular_hole_are_rejected_precisely() {
    let inst = instance(input(
        8.0,
        8.0,
        json!([0, 45, 90]),
        json!({
            "outer": [[0,0],[100,0],[100,100],[0,100]],
            "boards": [{
                "outer": [[0,0],[100,0],[100,30],[40,30],[40,100],[0,100]],
                "holes": [[[8,8],[28,8],[28,18],[18,28],[8,28]]]
            }]
        }),
    ));
    assert!(sample_valid(&inst, 600).len() > 550);
}

#[test]
fn only_fitting_rotation_is_selected_and_narrow_board_is_skipped() {
    let inst = instance(input(
        8.0,
        3.0,
        json!([0, 90]),
        json!({
            "outer": [[0,0],[100,0],[100,100],[0,100]],
            "boards": [
                {"outer": [[0,0],[2,0],[2,100],[0,100]]},
                {"outer": [[80,0],[84,0],[84,12],[80,12]]}
            ]
        }),
    ));
    let samples = sample_valid(&inst, 120);
    assert_eq!(samples.len(), 120);
    assert!(
        samples
            .iter()
            .all(|dt| (dt.rotation() - std::f32::consts::FRAC_PI_2).abs() < 1e-5)
    );
}

struct Recorder<'a> {
    boards: &'a [SPBoardDomain],
    samples: &'a RefCell<Vec<DTransformation>>,
}
impl SampleEvaluator for Recorder<'_> {
    fn stock_boards(&self) -> &[SPBoardDomain] {
        self.boards
    }
    fn evaluate_sample(&mut self, dt: DTransformation, _: Option<SampleEval>) -> SampleEval {
        self.samples.borrow_mut().push(dt);
        SampleEval::Invalid
    }
    fn n_evals(&self) -> usize {
        self.samples.borrow().len()
    }
}

fn config(n: usize) -> SampleConfig {
    SampleConfig {
        n_container_samples: n,
        n_focussed_samples: 0,
        n_coord_descents: 1,
    }
}

#[test]
fn search_retains_twenty_percent_global_exploration_and_fixed_evaluation_budget() {
    let inst = instance(input(8.0, 8.0, json!([0]), separated()));
    let problem = SPProblem::new(inst.clone());
    let boards = &inst.stock_constraints.as_ref().unwrap().boards;
    let samples = RefCell::new(Vec::new());
    let (best, n) = search_placement(
        &problem.layout,
        inst.item(0),
        None,
        Recorder {
            boards,
            samples: &samples,
        },
        config(250),
        &mut Xoshiro256PlusPlus::seed_from_u64(41),
    );
    assert!(best.is_none());
    assert_eq!(n, 250);
    let mut explored_gap = false;
    for (i, dt) in samples.borrow().iter().enumerate() {
        let bbox = inst.item(0).shape_cd.transform_clone(&dt.compose()).bbox;
        let in_board = bbox.x_max <= 40.0 && bbox.y_max <= 35.0 || bbox.x_min >= 120.0;
        if i % 5 != 0 {
            assert!(in_board);
        } else if !in_board {
            explored_gap = true;
        }
    }
    assert!(explored_gap);
}

#[test]
fn legacy_empty_boards_and_no_fitting_board_preserve_original_uniform_stream() {
    for geometry in [
        json!({"outer": [[0,0],[100,0],[100,100],[0,100]]}),
        json!({"outer": [[0,0],[100,0],[100,100],[0,100]], "boards": [
            {"outer": [[0,0],[4,0],[4,100],[0,100]]},
            {"outer": [[96,0],[100,0],[100,100],[96,100]]}
        ]}),
    ] {
        let inst = instance(input(8.0, 8.0, json!([0]), geometry));
        let problem = SPProblem::new(inst.clone());
        let bbox = problem.layout.container.outer_cd.bbox;
        let boards = &inst.stock_constraints.as_ref().unwrap().boards;
        assert!(BoardSampler::new(boards, inst.item(0), bbox, bbox).is_none());
        let samples = RefCell::new(Vec::new());
        let mut actual_rng = Xoshiro256PlusPlus::seed_from_u64(42);
        let (_, n) = search_placement(
            &problem.layout,
            inst.item(0),
            None,
            Recorder {
                boards,
                samples: &samples,
            },
            config(30),
            &mut actual_rng,
        );
        assert_eq!(n, 30);
        let original = UniformBBoxSampler::new(bbox, inst.item(0), bbox).unwrap();
        let mut expected_rng = Xoshiro256PlusPlus::seed_from_u64(42);
        for actual in samples.borrow().iter() {
            let expected = original.sample(&mut expected_rng);
            assert_eq!(actual.rotation(), expected.rotation());
            assert_eq!(actual.translation(), expected.translation());
        }
    }
}

#[test]
fn exhausted_hole_rejection_is_bounded_and_falls_back() {
    let mut inst = instance(input(8.0, 8.0, json!([0]), separated()));
    let metadata = Arc::make_mut(inst.stock_constraints.as_mut().unwrap());
    for board in &mut metadata.boards {
        board.holes = vec![board.outer.clone()];
    }
    let problem = SPProblem::new(inst.clone());
    let bbox = problem.layout.container.outer_cd.bbox;
    let boards = &inst.stock_constraints.as_ref().unwrap().boards;
    let mut sampler = BoardSampler::new(boards, inst.item(0), bbox, bbox).unwrap();
    assert!(
        sampler
            .sample(
                boards,
                inst.item(0),
                &mut Xoshiro256PlusPlus::seed_from_u64(1)
            )
            .is_none()
    );
    let samples = RefCell::new(Vec::new());
    let (_, n) = search_placement(
        &problem.layout,
        inst.item(0),
        None,
        Recorder {
            boards,
            samples: &samples,
        },
        config(25),
        &mut Xoshiro256PlusPlus::seed_from_u64(1),
    );
    assert_eq!(n, 25);
}

#[test]
fn constructors_and_separator_evaluator_keep_constraints_identity_and_collision_moves() {
    let inst = instance(input(8.0, 8.0, json!([0]), separated()));
    let constraints = inst.stock_constraints.as_ref().unwrap().clone();
    assert_eq!(constraints.boards[0].outer.bbox.y_max, 35.0);
    let builder = LBFBuilder::new(
        inst.clone(),
        Xoshiro256PlusPlus::seed_from_u64(13),
        config(40),
    )
    .construct()
    .unwrap();
    assert!(
        builder.prob.layout.cde().detect_poly_collision(
            &inst
                .item(0)
                .shape_cd
                .transform_clone(&Transformation::from_translation((60.0, 10.0))),
            &NoFilter
        )
    );
    assert!(Arc::ptr_eq(
        &constraints,
        builder.instance.stock_constraints.as_ref().unwrap()
    ));
    let mut problem = SPProblem::new(inst.clone());
    let pk = problem.place_item(SPPlacement {
        item_id: 0,
        d_transf: DTransformation::new(0.0, (60.0, 10.0)),
    });
    let tracker = CollisionTracker::new(&problem.layout);
    let mut evaluator = SeparationEvaluator::new(&problem.layout, inst.item(0), pk, &tracker)
        .with_stock_boards(&constraints.boards);
    assert_eq!(evaluator.stock_boards().len(), 2);
    assert!(matches!(
        evaluator.evaluate_sample(DTransformation::new(0.0, (61.0, 10.0)), None),
        SampleEval::Collision { .. }
    ));
    let lbf =
        LBFEvaluator::new(&problem.layout, inst.item(0)).with_stock_boards(&constraints.boards);
    assert_eq!(lbf.stock_boards().len(), 2);
    let samples = RefCell::new(Vec::new());
    let (_, n) = search_placement(
        &problem.layout,
        inst.item(0),
        Some(pk),
        Recorder {
            boards: &constraints.boards,
            samples: &samples,
        },
        SampleConfig {
            n_focussed_samples: 20,
            ..config(25)
        },
        &mut Xoshiro256PlusPlus::seed_from_u64(9),
    );
    assert_eq!(n, 46);
    let (best, _) = search_placement(
        &problem.layout,
        inst.item(0),
        Some(pk),
        evaluator,
        config(60),
        &mut Xoshiro256PlusPlus::seed_from_u64(17),
    );
    assert!(matches!(best, Some((_, SampleEval::Clear { .. }))));
    assert!(Arc::ptr_eq(
        &constraints,
        problem.instance.stock_constraints.as_ref().unwrap()
    ));
}

#[test]
fn continuous_rotation_and_physical_hole_metadata_are_preserved() {
    let mut inst = instance(input(
        8.0,
        3.0,
        json!([0]),
        json!({
            "outer": [[0,0],[100,0],[100,100],[0,100]],
            "boards": [{
                "outer": [[0,0],[100,0],[100,100],[0,100]],
                "holes": [[[20,20],[40,20],[35,40],[20,30]]]
            }]
        }),
    ));
    inst.items[0].0.allowed_rotation = jagua_rs::geometry::geo_enums::RotationRange::Continuous;
    let boards = &inst.stock_constraints.as_ref().unwrap().boards;
    assert_eq!(boards[0].holes.len(), 1);
    assert_eq!(boards[0].holes[0].vertices.len(), 4);
    assert_eq!(boards[0].holes[0].bbox.x_min, 20.0);
    let samples = sample_valid(&inst, 160);
    assert_eq!(samples.len(), 160);
    assert!(samples.iter().any(|dt| dt.rotation() > 0.1));
    for dt in samples {
        let grid_index = dt.rotation() * 16.0 / std::f32::consts::TAU;
        assert!((grid_index - grid_index.round()).abs() < 1e-5);
    }
}

#[test]
fn edge_candidates_stay_in_one_board_and_include_boundary_contacts() {
    let inst = instance(input(8.0, 8.0, json!([0]), separated()));
    let problem = SPProblem::new(inst.clone());
    let boards = &inst.stock_constraints.as_ref().unwrap().boards;
    let item = inst.item(0);
    let bbox = problem.layout.container.outer_cd.bbox;
    let mut sampler = BoardSampler::new(boards, item, bbox, bbox).unwrap();
    let mut rng = Xoshiro256PlusPlus::seed_from_u64(91);
    let anchor = jagua_rs::geometry::primitives::Rect::try_new(10.0, 10.0, 18.0, 18.0).unwrap();
    let mut touched_boundary = false;
    let mut adjacent_anchor = false;
    for _ in 0..300 {
        let dt = sampler
            .sample_edge(boards, item, &[anchor], &mut rng)
            .unwrap();
        let shape = item.shape_cd.transform_clone(&dt.compose());
        assert!(
            !problem
                .layout
                .cde()
                .detect_poly_collision(&shape, &NoFilter),
            "edge sample {dt:?}, bounds {:?}",
            shape.bbox
        );
        let near = |a: f32, b: f32| (a - b).abs() < 0.001;
        touched_boundary |= near(shape.bbox.x_min, 0.0)
            || near(shape.bbox.x_max, 40.0)
            || near(shape.bbox.x_min, 120.0)
            || near(shape.bbox.x_max, 160.0)
            || near(shape.bbox.y_min, 0.0);
        adjacent_anchor |= near(shape.bbox.x_min, anchor.x_max)
            || near(shape.bbox.x_max, anchor.x_min)
            || near(shape.bbox.y_min, anchor.y_max)
            || near(shape.bbox.y_max, anchor.y_min);
    }
    assert!(touched_boundary);
    assert!(adjacent_anchor);
}
