use super::assertions;
use super::qt_traits::QTQueryable;
use crate::geometry::geo_traits::CollidesWith;
use crate::geometry::primitives::{Edge, Point, Rect};

use crate::collision_detection::quadtree::{QTHazPresence, QTHazard};
use crate::collision_detection::{
    CDEConfig, CDEngine,
    hazards::{
        Hazard, HazardEntity,
        collector::{BasicHazardCollector, HazardCollector},
    },
};
use crate::geometry::{fail_fast::SPSurrogateConfig, primitives::SPolygon};
use std::sync::Arc;

fn root_config() -> CDEConfig {
    CDEConfig {
        quadtree_depth: 4,
        cd_threshold: 0,
        item_surrogate_config: SPSurrogateConfig::none(),
    }
}

#[test]
fn root_presence_handles_outside_entire_crossing_and_exterior_scope() {
    let root = Rect::try_new(0.0, 0.0, 10.0, 10.0).unwrap();
    let boxes = [
        Rect::try_new(900.0, 0.0, 910.0, 10.0).unwrap(),
        Rect::try_new(-10.0, -10.0, 20.0, 20.0).unwrap(),
        Rect::try_new(8.0, -2.0, 12.0, 12.0).unwrap(),
    ];
    for (idx, bbox) in boxes.into_iter().enumerate() {
        for exterior in [false, true] {
            let entity = if exterior {
                HazardEntity::Exterior
            } else {
                HazardEntity::Hole { idx }
            };
            let hazard = Hazard::new(entity, Arc::new(SPolygon::from(bbox)), false);
            let mut map = slotmap::SlotMap::with_key();
            let key = map.insert(hazard);
            let qt_haz = QTHazard::from_root(root, &map[key], key);
            match (idx, exterior) {
                (0, false) | (1, true) => assert!(matches!(qt_haz.presence, QTHazPresence::None)),
                (0, true) | (1, false) => assert!(matches!(qt_haz.presence, QTHazPresence::Entire)),
                _ => assert!(matches!(qt_haz.presence, QTHazPresence::Partial(_))),
            }
            let mut node = super::QTNode::new(4, root, 0);
            node.register_hazard(qt_haz, &map);
            assert_eq!(
                node.hazards.iter().count(),
                usize::from(!matches!((idx, exterior), (0, false) | (1, true)))
            );
            assert_eq!(map.len(), 1);
        }
    }
}

#[test]
fn root_collectors_preserve_hole_ids_for_entire_crossing_and_outside() {
    let root = Rect::try_new(0.0, 0.0, 10.0, 10.0).unwrap();
    let hazards = vec![
        Hazard::new(
            HazardEntity::Exterior,
            Arc::new(SPolygon::from(root)),
            false,
        ),
        Hazard::new(
            HazardEntity::Hole { idx: 0 },
            Arc::new(SPolygon::from(
                Rect::try_new(900.0, 0.0, 910.0, 10.0).unwrap(),
            )),
            false,
        ),
        Hazard::new(
            HazardEntity::Hole { idx: 1 },
            Arc::new(SPolygon::from(
                Rect::try_new(-10.0, -10.0, 20.0, 20.0).unwrap(),
            )),
            false,
        ),
        Hazard::new(
            HazardEntity::Hole { idx: 2 },
            Arc::new(SPolygon::from(
                Rect::try_new(8.0, -2.0, 12.0, 12.0).unwrap(),
            )),
            false,
        ),
    ];
    let cde = CDEngine::new(root, hazards, root_config());
    assert_eq!(cde.hazards_map.len(), 4);
    let query = SPolygon::from(Rect::try_new(8.5, 2.0, 9.5, 3.0).unwrap());
    let mut collector = BasicHazardCollector::new();
    cde.collect_poly_collisions(&query, &mut collector);
    assert!(!collector.contains_entity(&HazardEntity::Hole { idx: 0 }));
    assert!(collector.contains_entity(&HazardEntity::Hole { idx: 1 }));
    assert!(collector.contains_entity(&HazardEntity::Hole { idx: 2 }));
    assert!(!collector.contains_entity(&HazardEntity::Exterior));
}

#[test]
fn edge_quadrants_allow_f32_false_positive_at_bisector() {
    let rect = Rect::try_new(0.0, 6.1875, 100.0, 106.1875).unwrap();
    let quadrants = rect.quadrants();
    let edge = Edge {
        start: Point(-29.439_144, -32.354_836),
        end: Point(51.902_332, 212.291_02),
    };
    let bisector_y = rect.centroid().1;
    let crossing_fraction =
        -f64::from(edge.start.0) / (f64::from(edge.end.0) - f64::from(edge.start.0));
    let crossing_y = f64::from(edge.start.1)
        + crossing_fraction * (f64::from(edge.end.1) - f64::from(edge.start.1));
    let bisector_ulp = f32::from_bits(bisector_y.to_bits() + 1) - bisector_y;

    assert!(crossing_y > f64::from(bisector_y));
    assert!(crossing_y - f64::from(bisector_y) < f64::from(bisector_ulp));

    assert_eq!(
        quadrants.map(|quadrant| edge.collides_with(&quadrant)),
        [false, true, true, false]
    );
    assert_eq!(
        assertions::edge_collisions_with_rects_f64(&edge, quadrants.each_ref()),
        [false, true, false, false]
    );
    assert_eq!(
        edge.collides_with_quadrants(&rect, quadrants.each_ref()),
        [false, true, false, false]
    );
}
