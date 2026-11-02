use super::*;
use jagua_rs::entities::Instance;
use sparrow::consts::LBF_SAMPLE_CONFIG;
use sparrow::optimizer::lbf::LBFBuilder;

#[path = "circle_repro_tests.rs"]
mod circle_repro;

#[test]
fn automatic_runs_ignore_phase_timeouts_but_timed_runs_keep_them() {
    let mut automatic = WebTerminator {
        timed: false,
        inner: BasicTerminator::new(),
        interrupt: None,
    };
    automatic.new_timeout(Duration::ZERO);
    assert_eq!(automatic.timeout_at(), None);
    assert!(!automatic.kill());
    let mut timed = WebTerminator {
        timed: true,
        inner: BasicTerminator::new(),
        interrupt: None,
    };
    timed.new_timeout(Duration::from_secs(10));
    assert!(timed.timeout_at().is_some());
    assert!(!timed.kill());
}

#[test]
fn clearance_is_a_full_gap_and_a_full_edge_allowance() {
    let input: ExtSPInstance = serde_json::from_value(json!({
        "name":"two rectangles", "strip_height":16,
        "items":[{"id":0,"demand":2,"allowed_orientations":[0],
            "shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":10,"height":10}}}]
    }))
    .unwrap();
    let epoch = Instant::now();
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, Some(2.0), None);
    let instance = import_instance(&importer, &input).unwrap();
    let builder = LBFBuilder::new(
        instance.clone(),
        Xoshiro256PlusPlus::seed_from_u64(42),
        LBF_SAMPLE_CONFIG,
    )
    .construct().unwrap();
    let solution = export(&instance, &builder.prob.save(), epoch);
    let mut positions: Vec<_> = solution
        .layout
        .placed_items
        .iter()
        .map(|p| p.transformation.translation)
        .collect();
    positions.sort_by(|a, b| a.0.total_cmp(&b.0));
    let gap = positions[1].0 - positions[0].0 - 10.0;
    let edge = positions
        .iter()
        .map(|p| p.1.min(16.0 - p.1 - 10.0))
        .fold(f32::INFINITY, f32::min);
    println!("part gap={gap}, material edge allowance={edge}, positions={positions:?}");
    assert!((2.0 - 1e-4..2.1).contains(&gap));
    assert!((2.0 - 1e-4..2.1).contains(&edge));
}

#[test]
fn fast_preset_matches_imported_search_config_and_respects_worker_limit() {
    let fast = solver_config("fast", 3, None).unwrap();
    assert_eq!(fast.expl_cfg.shrink_step, 0.01);
    assert_eq!(fast.expl_cfg.max_conseq_failed_attempts, Some(10));
    assert_eq!(fast.expl_cfg.separator_config.iter_no_imprv_limit, 50);
    assert_eq!(fast.expl_cfg.separator_config.strike_limit, 2);
    assert_eq!(fast.expl_cfg.separator_config.n_workers, 2);
    assert_eq!(fast.cmpr_cfg.separator_config.n_workers, 3);
    assert_eq!(fast.cmpr_cfg.shrink_range, (0.0005, 0.0001));
    assert!(matches!(
        fast.cmpr_cfg.shrink_decay,
        ShrinkDecayStrategy::FailureBased(0.9)
    ));
    assert_eq!(fast.cmpr_cfg.separator_config.iter_no_imprv_limit, 50);
    assert_eq!(fast.cmpr_cfg.separator_config.strike_limit, 2);
    assert_eq!(fast.cde_config.cd_threshold, 16);
    let serial = solver_config("fast", 1, Some(300)).unwrap();
    assert_eq!(serial.expl_cfg.separator_config.n_workers, 1);
    assert_eq!(serial.cmpr_cfg.separator_config.n_workers, 1);
    assert_eq!(serial.expl_cfg.time_limit, Duration::from_secs(240));
    assert_eq!(serial.cmpr_cfg.time_limit, Duration::from_secs(60));
    let standard = solver_config("standard", 3, None).unwrap();
    assert_eq!(
        standard.expl_cfg.shrink_step,
        DEFAULT_SPARROW_CONFIG.expl_cfg.shrink_step
    );
    assert_eq!(
        standard.cmpr_cfg.separator_config.strike_limit,
        DEFAULT_SPARROW_CONFIG
            .cmpr_cfg
            .separator_config
            .strike_limit
    );
    assert!(solver_config("unknown", 3, None).is_err());
}

#[test]
fn exact_material_fit_returns_construction_error() {
    for demand in [1, 2] {
        let input: ExtSPInstance = serde_json::from_value(json!({
            "name":"exact fit", "strip_height":60.0,
            "items":[{"id":0,"demand":demand,"allowed_orientations":[0.0],
                "shape":{"type":"rectangle","data":{"x_min":0.0,"y_min":0.0,"width":100.0,"height":60.0}}}]
        })).unwrap();
        let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, None, None);
        let instance = import_instance(&importer, &input).unwrap();
        let error = LBFBuilder::new(instance, Xoshiro256PlusPlus::seed_from_u64(42), LBF_SAMPLE_CONFIG)
            .construct().err().expect("exact boundary contact must be rejected");
        assert_eq!(error.item_id, 0);
    }
}

#[test]
fn rectangular_boundary_contact_preserves_collision_and_collection_checks() {
    use jagua_rs::collision_detection::hazards::{
        collector::BasicHazardCollector, filter::NoFilter,
    };
    use jagua_rs::geometry::{Transformation, geo_traits::Transformable};
    use jagua_rs::probs::spp::entities::{SPPlacement, SPProblem};
    let input: ExtSPInstance = serde_json::from_value(json!({
        "name":"boundary checks", "strip_height":60.0,
        "items":[{"id":0,"demand":2,"allowed_orientations":[0.0],
            "shape":{"type":"rectangle","data":{"x_min":0.0,"y_min":0.0,"width":100.0,"height":60.0}}}]
    })).unwrap();
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, None, None);
    let instance = import_instance(&importer, &input).unwrap();
    let mut prob = SPProblem::new(instance.clone());
    for y in [30.0, 30.001, 29.999] {
        let transform = Transformation::from_translation((50.0, y));
        let shape = instance.item(0).shape_cd.transform_clone(&transform);
        let cde = prob.layout.cde();
        assert!(cde.detect_poly_collision(&shape, &NoFilter));
        let mut collisions = BasicHazardCollector::new();
        cde.collect_poly_collisions(&shape, &mut collisions);
        assert!(!collisions.is_empty());
    }
    let mut interior_input = input;
    interior_input.strip_height = 62.0;
    let instance = import_instance(&importer, &interior_input).unwrap();
    prob = SPProblem::new(instance.clone());
    let interior = instance.item(0).shape_cd.transform_clone(&Transformation::from_translation((51.0, 31.0)));
    assert!(!prob.layout.cde().detect_poly_collision(&interior, &NoFilter));
    assert!(!prob.layout.cde().detect_surrogate_collision(interior.surrogate(), &Transformation::empty(), &NoFilter));
    let mut interior_collisions = BasicHazardCollector::new();
    prob.layout.cde().collect_poly_collisions(&interior, &mut interior_collisions);
    assert!(interior_collisions.is_empty());
    prob.place_item(SPPlacement {
        item_id: 0,
        d_transf: jagua_rs::geometry::DTransformation::new(0.0, (51.0, 31.0)),
    });
    let shape = instance
        .item(0)
        .shape_cd
        .transform_clone(&Transformation::from_translation((51.0, 31.0)));
    assert!(prob.layout.cde().detect_poly_collision(&shape, &NoFilter));
    let mut collisions = BasicHazardCollector::new();
    prob.layout
        .cde()
        .collect_poly_collisions(&shape, &mut collisions);
    assert!(!collisions.is_empty());
}

fn stock_instance(geometry: serde_json::Value, clearance: Option<f32>) -> SPInstance {
    let value = json!({
        "name":"stock test", "strip_height":100,
        "items":[{"id":0,"demand":3,"allowed_orientations":[0],
            "shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":8,"height":8}}}],
        "stock_geometry":geometry
    });
    let external: ExtSPInstance = serde_json::from_value(value.clone()).unwrap();
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, clearance, None);
    let instance = import_instance(&importer, &external).unwrap();
    stock::apply(instance, stock::parse(&value.to_string(), 100.0).unwrap()).unwrap()
}

#[test]
fn concave_and_holed_stock_construct_only_parts_and_keep_fixed_hazards() {
    use jagua_rs::collision_detection::hazards::filter::NoFilter;
    use jagua_rs::geometry::{Transformation, geo_traits::Transformable};
    use jagua_rs::probs::spp::entities::SPProblem;
    for geometry in [
        json!({"outer":[[0,0],[100,0],[100,40],[40,40],[40,100],[0,100]]}),
        json!({"outer":[[0,0],[100,0],[100,100],[0,100]],
            "holes":[[[35,35],[65,35],[65,65],[35,65]]]}),
    ] {
        let instance = stock_instance(geometry, None);
        let builder = LBFBuilder::new(instance.clone(), Xoshiro256PlusPlus::seed_from_u64(42), LBF_SAMPLE_CONFIG)
            .construct().unwrap();
        let solution = builder.prob.save();
        let output = export(&instance, &solution, Instant::now());
        assert_eq!(output.layout.placed_items.len(), 3);
        assert!(output.layout.placed_items.iter().all(|p| p.item_id == 0));
        let mut empty = SPProblem::new(instance.clone());
        empty.change_strip_width(solution.strip.width);
        for placed in builder.prob.layout.placed_items.values() {
            assert!(!empty.layout.cde().detect_poly_collision(&placed.shape, &NoFilter));
        }
        let blocked = instance.item(0).shape_cd.transform_clone(&Transformation::from_translation((50.0, 50.0)));
        assert!(empty.layout.cde().detect_poly_collision(&blocked, &NoFilter));
        assert!(builder.prob.layout.cde().detect_poly_collision(&blocked, &NoFilter));
        let before = empty.layout.container.quality_zones[0].as_ref().unwrap().shapes_cd.clone();
        empty.change_strip_width(100.0);
        let after = &empty.layout.container.quality_zones[0].as_ref().unwrap().shapes_cd;
        assert_eq!(before.len(), after.len());
        for (a, b) in before.iter().zip(after) {
            assert_eq!(a.vertices, b.vertices);
        }
        assert!(empty.layout.cde().detect_poly_collision(&blocked, &NoFilter));
    }
}

#[test]
fn stock_forbidden_union_preserves_area_and_coordinates_without_offsets() {
    for (geometry, area) in [
        (json!({"outer":[[0,0],[100,0],[100,40],[40,40],[40,100],[0,100]]}), 3600.0),
        (json!({"outer":[[0,0],[100,0],[100,100],[0,100]]}), 0.0),
        (json!({"outer":[[0,0],[100,0],[100,100],[0,100]],
            "holes":[[[20,20],[50,20],[50,50],[20,50]],[[40,20],[70,20],[70,50],[40,50]]]}), 1500.0),
        (json!({"outer":[[10,10],[90,10],[90,90],[10,90]]}), 2600.0),
    ] {
        let constraints = stock::parse(&json!({"stock_geometry":geometry}).to_string(), 100.0).unwrap().unwrap();
        assert!((constraints.holes.area() - area).abs() < 0.01);
        for (orig, cd) in constraints.holes.shapes_orig.iter().zip(&constraints.holes.shapes_cd) {
            assert_eq!(orig.shape.vertices, cd.vertices);
            assert_eq!(orig.modify_config.offset, None);
            assert_eq!(orig.modify_config.simplify_tolerance, None);
            assert_eq!(orig.pre_transform, jagua_rs::geometry::DTransformation::empty());
        }
    }
}

#[test]
fn stock_clearance_is_not_applied_to_static_holes_twice() {
    let geometry = json!({"outer":[[0,0],[100,0],[100,100],[0,100]],
        "holes":[[[35,35],[65,35],[65,65],[35,65]]]});
    let instance = stock_instance(geometry, Some(2.0));
    let stock = instance.stock_constraints.as_ref().unwrap();
    let hole = &stock.holes.shapes_cd[0];
    assert_eq!((hole.bbox.x_min, hole.bbox.x_max, hole.bbox.y_min, hole.bbox.y_max), (35.0, 65.0, 35.0, 65.0));
    assert_eq!(instance.item(0).shape_orig.modify_config.offset, Some(1.0));
    let builder = LBFBuilder::new(instance, Xoshiro256PlusPlus::seed_from_u64(42), LBF_SAMPLE_CONFIG)
        .construct().unwrap();
    assert!(builder.prob.layout.is_feasible());
}

#[test]
fn malformed_stock_is_rejected_and_missing_stock_is_unchanged() {
    for geometry in [
        json!({"outer":[]}),
        json!({"outer":[[0,0],[10,10],[0,10],[10,0]]}),
        json!({"outer":[[0,0],[10,0],[10,0],[0,10]]}),
        json!({"outer":[[0,0],[10,0],[20,0]]}),
        json!({"outer":[[-1,0],[10,0],[0,10]]}),
        json!({"outer":[[0,0],[10,0],[0,101]]}),
        json!({"outer":[[0,0],[10,0],[0,10]],"holes":[[[20,20],[30,20],[20,30]]]}),
        json!({"outer":[[0,0],[10,0],[10,10],[0,10]],"holes":[[[0,2],[4,2],[4,4],[0,4]]]}),
    ] {
        assert!(stock::parse(&json!({"stock_geometry":geometry}).to_string(), 100.0).is_err());
    }
    assert!(stock::parse(r#"{"stock_geometry":{"outer":[[0,0],[1e100,0],[0,10]]}}"#, 100.0).is_err());
    assert!(stock::parse("{}", 100.0).unwrap().is_none());
    let closed = json!({"stock_geometry":{"outer":[[0,0],[100,0],[100,100],[0,100],[0,0]]}});
    assert!(stock::parse(&closed.to_string(), 100.0).is_ok());
}

fn geo_polygon(shape: &jagua_rs::geometry::primitives::SPolygon) -> geo::Polygon<f64> {
    geo::Polygon::new(geo::LineString::from(shape.vertices.iter()
        .map(|p| (f64::from(p.0), f64::from(p.1))).collect::<Vec<_>>()), vec![])
}

struct StockOptimizationListener {
    allowed: geo::MultiPolygon<f64>,
    static_holes: Vec<Vec<jagua_rs::geometry::primitives::Point>>,
    phases: Vec<OptimizationPhase>,
    feasible: usize,
    finals: usize,
    compression_attempts: usize,
    separations: usize,
    separation_phases: Vec<OptimizationPhase>,
    widths: Vec<f32>,
}

impl SolutionListener for StockOptimizationListener {
    fn report_phase(&mut self, phase: OptimizationPhase) {
        self.phases.push(phase);
    }

    fn report_compression_progress(&mut self, _step: f32) {
        self.compression_attempts += 1;
    }

    fn report_separation_result(&mut self, _result: sparrow::util::listener::SeparationResult) {
        self.separations += 1;
        self.separation_phases.push(*self.phases.last().unwrap());
    }

    fn report(&mut self, report: ReportType, solution: &SPSolution, instance: &SPInstance) {
        use geo::{Area, BooleanOps};
        let holes = &solution.layout_snapshot.container.quality_zones[0].as_ref().unwrap().shapes_cd;
        assert_eq!(holes.len(), self.static_holes.len());
        for (shape, expected) in holes.iter().zip(&self.static_holes) {
            assert_eq!(&shape.vertices, expected, "static holes moved during {report:?}");
        }
        self.widths.push(solution.strip.width);
        if !matches!(report, ReportType::ExplFeas | ReportType::CmprFeas | ReportType::Final) {
            return;
        }
        self.feasible += 1;
        self.finals += usize::from(matches!(report, ReportType::Final));
        let mut counts = vec![0; instance.items.len()];
        for placed in solution.layout_snapshot.placed_items.values() {
            counts[placed.item_id] += 1;
            let polygon = geo_polygon(&placed.shape);
            let outside = polygon.difference(&self.allowed).unsigned_area();
            assert!(outside < 1e-4, "{report:?}: part entered forbidden stock by area {outside}");
        }
        assert_eq!(counts, instance.items.iter().map(|(_, demand)| *demand).collect::<Vec<_>>());
        let output = export(instance, solution, Instant::now() - Duration::from_secs(60));
        assert_eq!(output.layout.placed_items.len(), 4);
        assert!(output.layout.placed_items.iter().all(|part| part.item_id == 0));
    }
}

#[test]
fn full_optimize_preserves_concave_and_holed_stock_with_one_and_three_workers() {
    use geo::BooleanOps;
    use jagua_rs::probs::spp::entities::SPProblem;
    for workers in [1, 3] {
        for geometry in [
            json!({"outer":[[0,0],[100,0],[100,60],[60,60],[60,100],[0,100]]}),
            json!({"outer":[[0,0],[100,0],[100,100],[0,100]],
                "holes":[[[35,35],[65,35],[65,65],[35,65]]]}),
        ] {
            let input = json!({"name":"full stock optimization", "strip_height":100,
                "items":[{"id":0,"demand":4,"allowed_orientations":[0],
                    "shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":24,"height":35}}}],
                "stock_geometry":geometry});
            let external: ExtSPInstance = serde_json::from_value(input.clone()).unwrap();
            let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, None, None);
            let instance = stock::apply(import_instance(&importer, &external).unwrap(),
                stock::parse(&input.to_string(), 100.0).unwrap()).unwrap();
            let ring = |value: &serde_json::Value| geo::Polygon::new(geo::LineString::from(
                value.as_array().unwrap().iter().map(|p| (p[0].as_f64().unwrap(), p[1].as_f64().unwrap()))
                    .collect::<Vec<_>>()), vec![]);
            let mut allowed = geo::MultiPolygon(vec![ring(&geometry["outer"])]);
            if let Some(holes) = geometry["holes"].as_array() {
                for hole in holes { allowed = allowed.difference(&ring(hole)); }
            }
            let mut listener = StockOptimizationListener {
                allowed,
                static_holes: instance.stock_constraints.as_ref().unwrap().holes.shapes_cd.iter()
                    .map(|shape| shape.vertices.clone()).collect(),
                phases: vec![], feasible: 0, finals: 0, compression_attempts: 0,
                separations: 0, separation_phases: vec![], widths: vec![],
            };
            let mut config = solver_config("standard", workers, None).unwrap();
            config.expl_cfg.time_limit = Duration::from_millis(250);
            config.cmpr_cfg.time_limit = Duration::from_millis(250);
            config.expl_cfg.shrink_step = 0.75;
            config.expl_cfg.max_conseq_failed_attempts = Some(1);
            config.cmpr_cfg.shrink_range = (0.02, 0.005);
            config.cmpr_cfg.shrink_decay = ShrinkDecayStrategy::FailureBased(0.5);
            for separator in [&mut config.expl_cfg.separator_config, &mut config.cmpr_cfg.separator_config] {
                separator.n_workers = workers;
                separator.iter_no_imprv_limit = 4;
                separator.strike_limit = 1;
            }
            let solution = optimize(instance.clone(), Xoshiro256PlusPlus::seed_from_u64(4242),
                &mut listener, &mut BasicTerminator::new(), &config.expl_cfg, &config.cmpr_cfg, None).unwrap();
            assert_eq!(listener.phases, vec![OptimizationPhase::Exploration, OptimizationPhase::Compression]);
            assert!(listener.compression_attempts > 0, "Compression did not resize, workers={workers}");
            assert!(listener.separations > 0);
            assert!(listener.separation_phases.contains(&OptimizationPhase::Exploration));
            assert!(listener.separation_phases.contains(&OptimizationPhase::Compression));
            assert!(listener.feasible >= 2);
            assert_eq!(listener.finals, 1);
            // Exercise snapshot restoration after a resize, including fresh-tree assertions.
            let mut restored = SPProblem::new(instance.clone());
            restored.change_strip_width(solution.strip.width);
            restored.restore(&solution);
            restored.change_strip_width(100.0);
            restored.restore(&solution);
            listener.report(ReportType::Final, &restored.save(), &instance);
            assert!(restored.layout.is_feasible());
            println!("stock optimize workers={workers}, phases={:?}, feasible={}, compression_attempts={}, separations={}, final_width={}",
                listener.phases, listener.feasible, listener.compression_attempts, listener.separations, solution.strip.width);
        }
    }
}
