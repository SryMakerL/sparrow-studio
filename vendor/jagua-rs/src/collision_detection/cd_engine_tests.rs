use super::*;
use crate::collision_detection::hazards::collector::BasicHazardCollector;
use crate::geometry::DTransformation;
use crate::geometry::primitives::Point;
use std::collections::HashSet;
use std::sync::Arc;

fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Rect {
    Rect::try_new(x0, y0, x1, y1).unwrap()
}

fn engine(root: Rect, container: Rect, threshold: u8, holes: Vec<SPolygon>) -> CDEngine {
    let mut hazards = vec![Hazard::new(
        HazardEntity::Exterior,
        Arc::new(container.into()),
        false,
    )];
    hazards.extend(
        holes
            .into_iter()
            .enumerate()
            .map(|(idx, shape)| Hazard::new(HazardEntity::Hole { idx }, Arc::new(shape), false)),
    );
    CDEngine::new(
        root,
        hazards,
        CDEConfig {
            quadtree_depth: 4,
            cd_threshold: threshold,
            item_surrogate_config: SPSurrogateConfig::none(),
        },
    )
}

fn placed(id: usize) -> HazardEntity {
    let mut keys: SlotMap<PItemKey, ()> = SlotMap::with_key();
    let pk = (0..=id).map(|_| keys.insert(())).last().unwrap();
    HazardEntity::PlacedItem {
        id,
        dt: DTransformation::empty(),
        pk,
    }
}

fn collisions(cde: &CDEngine, query: &SPolygon) -> HashSet<HazardEntity> {
    let mut collector = BasicHazardCollector::new();
    cde.collect_poly_collisions(query, &mut collector);
    collector.entities().copied().collect()
}

#[test]
fn outside_dynamic_self_and_other_are_collected_geometrically() {
    for threshold in [0, 16] {
        let root = rect(0.0, 0.0, 10.0, 10.0);
        let mut cde = engine(root, root, threshold, vec![]);
        let query = SPolygon::from(rect(20.0, 20.0, 24.0, 24.0));
        let self_entity = placed(0);
        let other_entity = placed(1);
        cde.register_hazard(Hazard::new(self_entity, Arc::new(query.clone()), true));
        cde.register_hazard(Hazard::new(
            other_entity,
            Arc::new(rect(23.0, 21.0, 26.0, 23.0).into()),
            true,
        ));
        cde.register_hazard(Hazard::new(
            placed(2),
            Arc::new(rect(30.0, 30.0, 32.0, 32.0).into()),
            true,
        ));
        let mut collector = BasicHazardCollector::new();
        cde.collect_poly_collisions(&query, &mut collector);
        assert_eq!(
            collector.entities().copied().collect::<HashSet<_>>(),
            HashSet::from([HazardEntity::Exterior, self_entity, other_entity])
        );
        collector.remove_by_entity(&self_entity);
        assert_eq!(collector.len(), 2);
    }
}

#[test]
fn outside_static_holes_support_both_containment_directions_and_bbox_rejection() {
    for threshold in [0, 16] {
        let root = rect(0.0, 0.0, 10.0, 10.0);
        let query = SPolygon::from(rect(20.0, 20.0, 24.0, 24.0));
        let cde = engine(
            root,
            root,
            threshold,
            vec![
                rect(19.0, 19.0, 25.0, 25.0).into(),
                rect(21.0, 21.0, 22.0, 22.0).into(),
                rect(30.0, 30.0, 32.0, 32.0).into(),
            ],
        );
        assert_eq!(
            collisions(&cde, &query),
            HashSet::from([
                HazardEntity::Exterior,
                HazardEntity::Hole { idx: 0 },
                HazardEntity::Hole { idx: 1 },
            ])
        );
    }
}

#[test]
fn partially_outside_query_finds_intersections_only_beyond_root() {
    for threshold in [0, 16] {
        let root = rect(0.0, 0.0, 10.0, 10.0);
        let mut cde = engine(root, root, threshold, vec![]);
        let query = SPolygon::from(rect(8.0, 2.0, 14.0, 4.0));
        let other = placed(0);
        let h_shape = SPolygon::from(rect(13.0, 3.0, 17.0, 7.0));
        assert!(!h_shape.collides_with(&query.poi.center));
        assert!(!query.collides_with(&h_shape.poi.center));
        cde.register_hazard(Hazard::new(other, Arc::new(h_shape), true));
        assert_eq!(
            collisions(&cde, &query),
            HashSet::from([HazardEntity::Exterior, other])
        );
    }
}

#[test]
fn exterior_requires_query_inside_container_not_the_reverse() {
    for threshold in [0, 16] {
        let root = rect(0.0, 0.0, 10.0, 10.0);
        let cde = engine(root, root, threshold, vec![]);
        let query = SPolygon::from(rect(-5.0, -5.0, 15.0, 15.0));
        assert_eq!(
            collisions(&cde, &query),
            HashSet::from([HazardEntity::Exterior])
        );

        let cde = engine(root, rect(-10.0, -10.0, 40.0, 40.0), threshold, vec![]);
        let inside_container = SPolygon::from(rect(20.0, 20.0, 24.0, 24.0));
        assert!(collisions(&cde, &inside_container).is_empty());
    }
}

#[test]
fn outside_prefill_and_early_stop_preserve_callback_contract() {
    for threshold in [0, 16] {
        let root = rect(0.0, 0.0, 10.0, 10.0);
        let cde = engine(
            root,
            root,
            threshold,
            vec![
                rect(19.0, 19.0, 25.0, 25.0).into(),
                rect(21.0, 21.0, 22.0, 22.0).into(),
            ],
        );
        let query = SPolygon::from(rect(20.0, 20.0, 24.0, 24.0));
        let mut collector = BasicHazardCollector::new();
        let (exterior_key, exterior) = cde
            .hazards_map
            .iter()
            .find(|(_, h)| h.entity == HazardEntity::Exterior)
            .unwrap();
        collector.insert(exterior_key, exterior.entity);
        let mut callbacks = vec![];
        assert!(
            cde.collect_poly_collisions_until(&query, &mut collector, |entity| {
                callbacks.push(entity);
                true
            })
        );
        assert_eq!(callbacks.len(), 1);
        assert_ne!(callbacks[0], HazardEntity::Exterior);
        assert_eq!(collector.len(), 2);
        assert!(
            !cde.collect_poly_collisions_until(&query, &mut collector, |entity| {
                callbacks.push(entity);
                false
            })
        );
        assert_eq!(callbacks.len(), 2);
        assert_ne!(callbacks[0], callbacks[1]);
        assert_eq!(collector.len(), 3);
        assert!(
            !cde.collect_poly_collisions_until(&query, &mut collector, |_| {
                panic!("prefilled collisions must not trigger callbacks")
            })
        );

        let mut empty = BasicHazardCollector::new();
        assert!(cde.collect_poly_collisions_until(&query, &mut empty, |_| true));
        assert_eq!(empty.len(), 1);
    }
}

#[test]
fn collision_sets_are_consistent_across_root_sizes_and_thresholds() {
    let container = rect(0.0, 0.0, 30.0, 30.0);
    let roots = [rect(0.0, 0.0, 10.0, 10.0), rect(-20.0, -20.0, 50.0, 50.0)];
    let queries = [
        rect(20.0, 20.0, 24.0, 24.0),
        rect(8.0, 2.0, 14.0, 4.0),
        rect(28.0, 2.0, 34.0, 4.0),
    ];
    for threshold in [0, 16] {
        for query in queries {
            let query = SPolygon::from(query);
            let sets = roots.map(|root| {
                let mut cde = engine(
                    root,
                    container,
                    threshold,
                    vec![rect(21.0, 21.0, 22.0, 22.0).into()],
                );
                cde.register_hazard(Hazard::new(placed(0), Arc::new(query.clone()), true));
                cde.register_hazard(Hazard::new(
                    placed(1),
                    Arc::new(rect(13.0, 3.0, 17.0, 7.0).into()),
                    true,
                ));
                collisions(&cde, &query)
            });
            assert_eq!(
                sets[0], sets[1],
                "threshold={threshold}, bbox={:?}",
                query.bbox
            );
        }
    }
}

#[test]
fn outside_concave_container_crossing_is_not_mistaken_for_containment() {
    for threshold in [0, 16] {
        let root = rect(0.0, 0.0, 2.0, 2.0);
        let container = SPolygon::new(vec![
            Point(0.0, 0.0),
            Point(10.0, 0.0),
            Point(10.0, 10.0),
            Point(7.0, 10.0),
            Point(7.0, 4.0),
            Point(3.0, 4.0),
            Point(3.0, 10.0),
            Point(0.0, 10.0),
        ])
        .unwrap();
        let mut cde = engine(root, rect(0.0, 0.0, 10.0, 10.0), threshold, vec![]);
        cde.deregister_hazard_by_entity(HazardEntity::Exterior);
        cde.register_hazard(Hazard::new(
            HazardEntity::Exterior,
            Arc::new(container),
            false,
        ));
        let query = SPolygon::from(rect(1.0, 2.0, 9.0, 6.0));
        assert_eq!(
            collisions(&cde, &query),
            HashSet::from([HazardEntity::Exterior])
        );
    }
}
