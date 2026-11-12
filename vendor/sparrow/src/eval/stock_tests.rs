use super::*;
use jagua_rs::collision_detection::{
    CDEConfig,
    hazards::collector::{BasicHazardCollector, HazardCollector},
};
use jagua_rs::entities::{InferiorQualityZone, Item};
use jagua_rs::geometry::{
    DTransformation, OriginalShape,
    fail_fast::SPSurrogateConfig,
    geo_enums::RotationRange,
    primitives::Rect,
    shape_modification::{ShapeModifyConfig, ShapeModifyMode},
};
use jagua_rs::probs::spp::entities::{
    SPInstance, SPPlacement, SPProblem, SPStockConstraints, Strip,
};
use rand::{SeedableRng, rngs::Xoshiro256PlusPlus};
use std::sync::Arc;

fn original(x: f32, y: f32, w: f32, h: f32) -> OriginalShape {
    OriginalShape {
        shape: Rect::try_new(x, y, x + w, y + h).unwrap().into(),
        pre_transform: DTransformation::empty(),
        modify_mode: ShapeModifyMode::Inflate,
        modify_config: ShapeModifyConfig::default(),
    }
}

fn instance(holes: Vec<OriginalShape>) -> SPInstance {
    let surrogate = SPSurrogateConfig {
        n_pole_limits: [(16, 0.0), (8, 0.8), (4, 0.9)],
        ff_pole_area_ratio: 0.5,
        n_ff_piers: 0,
    };
    let config = CDEConfig {
        quadtree_depth: 4,
        cd_threshold: 16,
        item_surrogate_config: surrogate,
    };
    let item = Item::new(
        0,
        original(0.0, 0.0, 4.0, 4.0),
        RotationRange::None,
        None,
        surrogate,
    )
    .unwrap();
    SPInstance::new(
        vec![(item, 1)],
        Strip::new(10.0, config, ShapeModifyConfig::default(), 10.0).unwrap(),
    )
    .with_stock_constraints(SPStockConstraints {
        boards: vec![],
        max_width: 10.0,
        holes: InferiorQualityZone::new(0, holes).unwrap(),
    })
    .unwrap()
}

fn check_loss(
    prob: &SPProblem,
    tracker: &CollisionTracker,
    pk: PItemKey,
    expected_holes: usize,
    exterior: bool,
) {
    let shape = &prob.layout.placed_items[pk].shape;
    let mut collector = BasicHazardCollector::new();
    prob.layout
        .cde()
        .collect_poly_collisions(shape, &mut collector);
    collector.remove_by_entity(&HazardEntity::from((pk, &prob.layout.placed_items[pk])));
    assert_eq!(
        collector
            .iter()
            .filter(|(_, h)| matches!(h, HazardEntity::Hole { .. }))
            .count(),
        expected_holes
    );
    assert_eq!(collector.contains_entity(&HazardEntity::Exterior), exterior);
    let mut evaluator = CollisionLossEvaluator::new(&prob.layout, tracker, pk);
    evaluator.reload(f32::INFINITY, shape);
    for (_, hazard) in collector.iter() {
        assert!(!evaluator.add(*hazard, shape));
    }
    let expected = tracker.get_weighted_loss(pk);
    assert!(expected > 0.0);
    assert!((evaluator.loss() - expected).abs() < expected * 1e-5);
    assert!(crate::util::assertions::tracker_matches_layout(
        tracker,
        &prob.layout
    ));
}

#[test]
fn holes_and_exterior_accumulate_through_move_weights_restore() {
    let inst = instance(vec![
        original(0.0, 2.0, 2.0, 2.0),
        original(2.0, 2.0, 2.0, 2.0),
    ]);
    let hole = inst.stock_constraints.as_ref().unwrap().holes.shapes_cd[0].clone();
    let mut prob = SPProblem::new(inst);
    let pk = prob.place_item(SPPlacement {
        item_id: 0,
        d_transf: DTransformation::new(0.0, (0.5, 1.0)),
    });
    let mut tracker = CollisionTracker::new(&prob.layout);
    check_loss(&prob, &tracker, pk, 2, false);
    let snapshot = prob.save();
    let ct_snapshot = tracker.save();
    let placement = prob.remove_item(pk);
    let new_pk = prob.place_item(SPPlacement {
        d_transf: DTransformation::new(0.0, (-0.5, 1.0)),
        ..placement
    });
    tracker.register_item_move(&prob.layout, pk, new_pk);
    check_loss(&prob, &tracker, new_pk, 2, true);
    tracker.update_weights();
    check_loss(&prob, &tracker, new_pk, 2, true);
    prob.change_strip_width(8.0);
    assert!(Arc::ptr_eq(
        &hole,
        &prob.layout.container.quality_zones[0]
            .as_ref()
            .unwrap()
            .shapes_cd[0]
    ));
    prob.restore(&snapshot);
    tracker.restore_but_keep_weights(&ct_snapshot, &prob.layout);
    check_loss(&prob, &tracker, pk, 2, false);
    assert!(Arc::ptr_eq(
        &hole,
        &prob.layout.container.quality_zones[0]
            .as_ref()
            .unwrap()
            .shapes_cd[0]
    ));
}

#[test]
fn fit_and_split_compression_leave_holes_fixed() {
    let inst = instance(vec![original(7.0, 7.0, 1.0, 1.0)]);
    let hole = inst.stock_constraints.as_ref().unwrap().holes.shapes_cd[0].clone();
    let mut prob = SPProblem::new(inst.clone());
    prob.place_item(SPPlacement {
        item_id: 0,
        d_transf: DTransformation::new(0.0, (1.0, 1.0)),
    });
    prob.fit_strip();
    assert!(prob.strip_width() < 10.0);
    assert!(Arc::ptr_eq(
        &hole,
        &prob.layout.container.quality_zones[0]
            .as_ref()
            .unwrap()
            .shapes_cd[0]
    ));
    let mut sep = crate::optimizer::separator::Separator::new(
        inst,
        prob,
        Xoshiro256PlusPlus::seed_from_u64(42),
        crate::optimizer::separator::SeparatorConfig {
            iter_no_imprv_limit: 1,
            strike_limit: 1,
            n_workers: 1,
            log_level: log::Level::Debug,
            sample_config: crate::consts::LBF_SAMPLE_CONFIG,
        },
    );
    sep.change_strip_width(4.5, Some(0.0));
    assert!(Arc::ptr_eq(
        &hole,
        &sep.prob.layout.container.quality_zones[0]
            .as_ref()
            .unwrap()
            .shapes_cd[0]
    ));
    assert_eq!(sep.prob.layout.placed_items.len(), 1);
}

#[test]
fn bounded_construction_returns_error_without_growing() {
    let inst = instance(vec![original(0.0, 0.0, 10.0, 10.0)]);
    let builder = crate::optimizer::lbf::LBFBuilder::new(
        inst,
        Xoshiro256PlusPlus::seed_from_u64(1),
        crate::sample::search::SampleConfig {
            n_container_samples: 4,
            n_focussed_samples: 0,
            n_coord_descents: 1,
        },
    );
    assert_eq!(builder.prob.strip_width(), 10.0);
    assert!(builder.construct().is_err());
}

#[test]
fn finite_limit_and_unconstrained_snapshot_rejected() {
    let inst = instance(vec![]);
    let mut prob = SPProblem::new(inst.clone());
    for width in [0.0, -1.0, 11.0, f32::INFINITY, f32::NAN] {
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                || prob.change_strip_width(width)
            ))
            .is_err()
        );
        assert_eq!(prob.strip_width(), 10.0);
    }
    let plain = SPInstance::new(inst.items.clone(), inst.base_strip);
    let plain_sol = SPProblem::new(plain).save();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| prob.restore(&plain_sol)))
            .is_err()
    );
    let invalid = SPStockConstraints {
        boards: vec![],
        max_width: f32::INFINITY,
        holes: InferiorQualityZone::new(0, vec![]).unwrap(),
    };
    assert!(
        SPInstance::new(inst.items.clone(), inst.base_strip)
            .with_stock_constraints(invalid)
            .is_err()
    );
}

#[test]
fn stock_holes_outside_root_survive_width_roundtrip() {
    let template = instance(vec![]);
    let inst = SPInstance::new(template.items, template.base_strip)
        .with_stock_constraints(SPStockConstraints {
            boards: vec![],
            max_width: 1000.0,
            holes: InferiorQualityZone::new(
                0,
                vec![
                    original(900.0, 0.0, 10.0, 10.0),
                    original(-100.0, -1000.0, 1200.0, 2000.0),
                    original(8.0, -2.0, 4.0, 14.0),
                ],
            )
            .unwrap(),
        })
        .unwrap();
    let holes = inst
        .stock_constraints
        .as_ref()
        .unwrap()
        .holes
        .shapes_cd
        .clone();
    let mut prob = SPProblem::new(inst);
    for width in [10.0, 1000.0, 10.0, 1000.0] {
        prob.change_strip_width(width);
        assert_eq!(prob.layout.cde().hazards_map.len(), 4);
        for (idx, hole) in holes.iter().enumerate() {
            assert!(Arc::ptr_eq(
                hole,
                &prob.layout.container.quality_zones[0]
                    .as_ref()
                    .unwrap()
                    .shapes_cd[idx]
            ));
            assert!(
                prob.layout
                    .cde()
                    .hazards()
                    .any(|h| h.entity == HazardEntity::Hole { idx })
            );
        }
        let near = Rect::try_new(8.5, 2.0, 9.5, 3.0).unwrap().into();
        let mut collector = BasicHazardCollector::new();
        prob.layout
            .cde()
            .collect_poly_collisions(&near, &mut collector);
        assert!(collector.contains_entity(&HazardEntity::Hole { idx: 1 }));
        assert!(collector.contains_entity(&HazardEntity::Hole { idx: 2 }));
        assert!(!collector.contains_entity(&HazardEntity::Hole { idx: 0 }));
        if width == 1000.0 {
            let far = Rect::try_new(902.0, 2.0, 904.0, 4.0).unwrap().into();
            let mut collector = BasicHazardCollector::new();
            prob.layout
                .cde()
                .collect_poly_collisions(&far, &mut collector);
            assert!(collector.contains_entity(&HazardEntity::Hole { idx: 0 }));
            assert!(collector.contains_entity(&HazardEntity::Hole { idx: 1 }));
            assert!(!collector.contains_entity(&HazardEntity::Hole { idx: 2 }));
        }
    }
}

#[test]
fn hole_evaluator_respects_zero_finite_and_infinite_bounds() {
    let mut prob = SPProblem::new(instance(vec![original(2.0, 2.0, 2.0, 2.0)]));
    let pk = prob.place_item(SPPlacement {
        item_id: 0,
        d_transf: DTransformation::new(0.0, (1.0, 1.0)),
    });
    let tracker = CollisionTracker::new(&prob.layout);
    let shape = &prob.layout.placed_items[pk].shape;
    let expected = tracker.get_weighted_loss(pk);
    assert!(expected.is_finite() && expected > 0.0);
    for (bound, should_stop) in [
        (0.0, true),
        (expected * 0.5, true),
        (expected * 2.0, false),
        (f32::INFINITY, false),
    ] {
        let mut evaluator = CollisionLossEvaluator::new(&prob.layout, &tracker, pk);
        evaluator.reload(bound, shape);
        assert_eq!(
            evaluator.add(HazardEntity::Hole { idx: 0 }, shape),
            should_stop
        );
        assert!((evaluator.loss() - expected).abs() < expected * 1e-5);
    }
}

#[test]
fn invalid_stock_width_limits_rejected() {
    let template = instance(vec![]);
    for max_width in [0.0, -1.0, f32::INFINITY, f32::NEG_INFINITY, f32::NAN, 9.0] {
        let result = SPInstance::new(template.items.clone(), template.base_strip)
            .with_stock_constraints(SPStockConstraints {
                boards: vec![],
                max_width,
                holes: InferiorQualityZone::new(0, vec![]).unwrap(),
            });
        assert!(result.is_err());
    }
}

#[test]
fn ordinary_strip_still_fits_and_restores() {
    let constrained = instance(vec![]);
    let inst = SPInstance::new(constrained.items, constrained.base_strip);
    assert!(inst.stock_constraints.is_none());
    let mut prob = SPProblem::new(inst);
    prob.place_item(SPPlacement {
        item_id: 0,
        d_transf: DTransformation::new(0.0, (1.0, 1.0)),
    });
    let snapshot = prob.save();
    prob.fit_strip();
    prob.restore(&snapshot);
    assert!(prob.layout.is_feasible());
    assert!(prob.layout.container.quality_zones[0].is_none());
}
