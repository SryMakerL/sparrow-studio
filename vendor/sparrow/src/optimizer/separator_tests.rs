use super::*;
use jagua_rs::collision_detection::CDEConfig;
use jagua_rs::entities::{InferiorQualityZone, Item};
use jagua_rs::geometry::{
    OriginalShape, fail_fast::SPSurrogateConfig, geo_enums::RotationRange,
    primitives::Rect, shape_modification::{ShapeModifyConfig, ShapeModifyMode},
};
use jagua_rs::probs::spp::entities::{SPStockConstraints, Strip};

fn original(x: f32, y: f32, w: f32, h: f32) -> OriginalShape {
    OriginalShape {
        shape: Rect::try_new(x, y, x + w, y + h).unwrap().into(),
        pre_transform: DTransformation::empty(),
        modify_mode: ShapeModifyMode::Inflate,
        modify_config: ShapeModifyConfig::default(),
    }
}

fn separator(positions: &[(f32, f32)], holes: Vec<OriginalShape>) -> Separator {
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
    let item = Item::new(0, original(0.0, 0.0, 4.0, 4.0), RotationRange::None, None, surrogate).unwrap();
    let instance = SPInstance::new(
        vec![(item, positions.len())],
        Strip::new(10.0, config, ShapeModifyConfig::default(), 10.0).unwrap(),
    ).with_stock_constraints(SPStockConstraints {
        max_width: 20.0,
        boards: vec![],
        holes: InferiorQualityZone::new(0, holes).unwrap(),
    }).unwrap();
    let mut prob = SPProblem::new(instance.clone());
    for &position in positions {
        prob.place_item(SPPlacement { item_id: 0, d_transf: DTransformation::new(0.0, position) });
    }
    Separator::new(instance, prob, Xoshiro256PlusPlus::seed_from_u64(42), SeparatorConfig {
        iter_no_imprv_limit: 1,
        strike_limit: 1,
        n_workers: 2,
        log_level: Level::Debug,
        sample_config: crate::consts::LBF_SAMPLE_CONFIG,
    })
}

#[test]
fn expansion_beyond_old_root() {
    let mut sep = separator(&[(6.0, 1.0)], vec![]);
    sep.change_strip_width(20.0, Some(5.0));
    assert_eq!(sep.prob.strip_width(), 20.0);
    let pi = sep.prob.layout.placed_items.values().next().unwrap();
    assert_eq!(pi.shape.bbox.x_min, 16.0);
    assert!(sep.ct.get_total_loss().is_finite());
    assert!(tracker_matches_layout(&sep.ct, &sep.prob.layout));
    assert_workers(&sep);
}

fn assert_workers(sep: &Separator) {
    let placements = format!("{:?}", sep.prob.layout.placed_items);
    let tracker = format!("{:?}", sep.ct);
    for worker in &sep.workers {
        assert_eq!(worker.prob.strip_width(), sep.prob.strip_width());
        assert_eq!(format!("{:?}", worker.prob.layout.placed_items), placements);
        assert_eq!(format!("{:?}", worker.ct), tracker);
        assert!(tracker_matches_layout(&worker.ct, &worker.prob.layout));
        assert_eq!(worker.prob.item_demand_qtys, sep.prob.item_demand_qtys);
    }
}

fn x_positions(sep: &Separator) -> Vec<f32> {
    let mut positions = sep.prob.layout.placed_items.values()
        .map(|pi| pi.shape.bbox.x_min).collect_vec();
    positions.sort_by(|a, b| a.total_cmp(b));
    positions
}

#[test]
fn split_roundtrip_keeps_left_and_equal_centroids_and_holes_fixed() {
    let mut sep = separator(&[(0.0, 1.0), (3.0, 1.0), (6.0, 1.0)],
        vec![original(17.0, 7.0, 1.0, 1.0)]);
    let hole = sep.prob.layout.container.quality_zones[0].as_ref().unwrap().shapes_cd[0].clone();
    sep.ct.update_weights();
    assert!(sep.ct.get_total_weighted_loss() > sep.ct.get_total_loss());
    for (width, split, expected) in [
        (20.0, 5.0, vec![0.0, 3.0, 16.0]),
        (10.0, 15.0, vec![0.0, 3.0, 6.0]),
    ] {
        sep.change_strip_width(width, Some(split));
        assert_eq!(x_positions(&sep), expected);
        assert_eq!(sep.prob.item_demand_qtys, vec![0]);
        assert!(std::sync::Arc::ptr_eq(&hole,
            &sep.prob.layout.container.quality_zones[0].as_ref().unwrap().shapes_cd[0]));
        assert_eq!(sep.ct.get_total_loss(), sep.ct.get_total_weighted_loss());
        assert_workers(&sep);
    }
}

#[test]
fn default_split_uses_old_center() {
    let mut sep = separator(&[(0.0, 1.0), (6.0, 1.0)], vec![]);
    sep.change_strip_width(20.0, None);
    assert_eq!(x_positions(&sep), vec![0.0, 16.0]);
    sep.change_strip_width(10.0, None);
    assert_eq!(x_positions(&sep), vec![0.0, 6.0]);
    assert!(sep.ct.get_total_loss().is_finite());
    assert_workers(&sep);
}

#[test]
fn no_selected_items_still_rebuilds_and_detects_exterior() {
    let mut sep = separator(&[(5.0, 1.0)], vec![]);
    for width in [20.0, 8.0, 10.0] {
        sep.change_strip_width(width, Some(100.0));
        assert_eq!(x_positions(&sep), vec![5.0]);
        let pk = sep.prob.layout.placed_items.keys().next().unwrap();
        assert_eq!(sep.ct.get_container_loss(pk) > 0.0, width == 8.0);
        assert_workers(&sep);
    }
}

#[test]
fn shrink_past_left_edge_and_pair_and_hole_collisions_remain_detectable() {
    let mut sep = separator(&[(1.0, 1.0), (6.0, 1.0)], vec![original(2.0, 2.0, 1.0, 1.0)]);
    sep.change_strip_width(7.0, Some(5.0));
    assert_eq!(x_positions(&sep), vec![1.0, 3.0]);
    let keys = sep.prob.layout.placed_items.keys().collect_vec();
    assert!(sep.ct.get_pair_loss(keys[0], keys[1]) > 0.0);
    assert!(keys.iter().any(|&pk| sep.ct.get_container_loss(pk) > 0.0));
    assert_workers(&sep);

    // Shrinking may create a real exterior collision, which must remain tracked.
    let mut sep = separator(&[(6.0, 1.0)], vec![]);
    sep.change_strip_width(20.0, Some(5.0));
    sep.change_strip_width(3.0, Some(0.0));
    assert_eq!(x_positions(&sep), vec![-1.0]);
    let pk = sep.prob.layout.placed_items.keys().next().unwrap();
    assert!(sep.ct.get_container_loss(pk) > 0.0);
    assert_workers(&sep);
}

#[test]
fn invalid_stock_widths_leave_master_workers_weights_and_rng_unchanged() {
    let mut sep = separator(&[(1.0, 1.0), (6.0, 1.0)], vec![original(2.0, 2.0, 1.0, 1.0)]);
    sep.ct.update_weights();
    let before = format!("{:?}{:?}{:?}", sep.prob.strip, sep.prob.layout.placed_items, sep.ct);
    let worker_states = sep.workers.iter().map(|w|
        format!("{:?}{:?}{:?}{:?}", w.prob.strip, w.prob.layout.placed_items, w.ct, w.rng)
    ).collect_vec();
    let rng = format!("{:?}", sep.rng);
    for width in [0.0, -1.0, 20.01, f32::INFINITY, f32::NEG_INFINITY, f32::NAN] {
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            sep.change_strip_width(width, Some(5.0))
        )).is_err());
        assert_eq!(format!("{:?}{:?}{:?}", sep.prob.strip, sep.prob.layout.placed_items, sep.ct), before);
        assert_eq!(format!("{:?}", sep.rng), rng);
        assert_eq!(sep.prob.item_demand_qtys, vec![0]);
        for (worker, state) in sep.workers.iter().zip(&worker_states) {
            assert_eq!(&format!("{:?}{:?}{:?}{:?}", worker.prob.strip, worker.prob.layout.placed_items, worker.ct, worker.rng), state);
        }
        assert!(tracker_matches_layout(&sep.ct, &sep.prob.layout));
    }
}
