#[path = "../src/stock.rs"]
mod stock;

use jagua_rs::collision_detection::hazards::filter::NoFilter;
use jagua_rs::entities::Instance;
use jagua_rs::geometry::{Transformation, geo_traits::Transformable};
use jagua_rs::io::import::Importer;
use jagua_rs::probs::spp::entities::SPProblem;
use jagua_rs::probs::spp::io::{ext_repr::ExtSPInstance, import_instance};
use serde_json::json;
use sparrow::config::DEFAULT_SPARROW_CONFIG;

#[test]
fn virtual_limit_boards_apply_and_detect_collision_without_f32_panics() {
    let input = json!({
        "name": "large translated boards", "strip_height": 100,
        "items": [{"id": 0, "demand": 1, "allowed_orientations": [0],
            "shape": {"type": "rectangle", "data": {
                "x_min": 0, "y_min": 0, "width": 8, "height": 8}}}],
        "stock_geometry": {
            "outer": [[0,0],[10000000,0],[10000000,100],[0,100]],
            "boards": [
                {"outer": [[0,0],[10,0],[10,100],[0,100]]},
                {"outer": [[9999900,0],[9999949,0],[9999949,100],[9999900,100]],
                 "holes": [[[9999920,20],[9999930,20],[9999930,40],[9999920,40]]]},
                {"outer": [[9999950,0],[10000000,0],[10000000,100],[9999950,100]]}
            ]
        }
    });
    let external: ExtSPInstance = serde_json::from_value(input.clone()).unwrap();
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, None, None);
    let instance = stock::apply(
        import_instance(&importer, &external).unwrap(),
        stock::parse(&input.to_string(), 100.0).unwrap(),
    )
    .unwrap();
    let problem = SPProblem::new(instance.clone());
    for (x, y, expected) in [
        (9_999_910.0, 10.0, false),
        (9_999_925.0, 30.0, true),
        (9_999_949.0, 50.0, true),
        (9_999_970.0, 50.0, false),
    ] {
        let shape = instance
            .item(0)
            .shape_cd
            .transform_clone(&Transformation::from_translation((x, y)));
        assert_eq!(
            problem
                .layout
                .cde()
                .detect_poly_collision(&shape, &NoFilter),
            expected,
            "collision at ({x}, {y})"
        );
    }
}

#[test]
fn translated_boards_keep_seams_top_blank_and_holes_as_fixed_collision_hazards() {
    let input = json!({
        "name": "translated boards",
        "strip_height": 100,
        "items": [{"id": 0, "demand": 1, "allowed_orientations": [0],
            "shape": {"type": "rectangle", "data": {
                "x_min": 0, "y_min": 0, "width": 8, "height": 8}}}],
        "stock_geometry": {
            "outer": [[0,0],[160,0],[160,100],[0,100]],
            "holes": [],
            "boards": [
                {"outer": [[0,0],[60,0],[60,70],[0,70]],
                 "holes": [[[20,20],[40,20],[40,40],[20,40]]]},
                {"outer": [[80,0],[160,0],[160,100],[80,100]]}
            ]
        }
    });
    let external: ExtSPInstance = serde_json::from_value(input.clone()).unwrap();
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, Some(2.0), None);
    let instance = stock::apply(
        import_instance(&importer, &external).unwrap(),
        stock::parse(&input.to_string(), 100.0).unwrap(),
    )
    .unwrap();
    assert_eq!(instance.item(0).shape_orig.modify_config.offset, Some(1.0));
    let constraints = instance.stock_constraints.as_ref().unwrap();
    assert!((constraints.holes.area() - 4200.0).abs() < 0.01);
    let mut problem = SPProblem::new(instance.clone());
    let detect = |problem: &SPProblem, x, y| {
        let shape = instance
            .item(0)
            .shape_cd
            .transform_clone(&Transformation::from_translation((x, y)));
        problem
            .layout
            .cde()
            .detect_poly_collision(&shape, &NoFilter)
    };
    assert!(detect(&problem, 65.0, 10.0), "virtual seam must be blocked");
    assert!(
        detect(&problem, 10.0, 80.0),
        "space above a shorter board must be blocked"
    );
    assert!(detect(&problem, 25.0, 25.0), "board holes must be blocked");
    assert!(!detect(&problem, 10.0, 10.0));
    assert!(!detect(&problem, 90.0, 10.0));
    assert!(
        !detect(&problem, 9.5, 22.0),
        "do not offset the board hole twice"
    );
    let fixed: Vec<_> = problem.layout.container.quality_zones[0]
        .as_ref()
        .unwrap()
        .shapes_cd
        .iter()
        .map(|shape| shape.vertices.clone())
        .collect();
    problem.change_strip_width(120.0);
    problem.change_strip_width(160.0);
    let after: Vec<_> = problem.layout.container.quality_zones[0]
        .as_ref()
        .unwrap()
        .shapes_cd
        .iter()
        .map(|shape| shape.vertices.clone())
        .collect();
    assert_eq!(fixed, after);
    assert!(detect(&problem, 65.0, 10.0));
    assert!(detect(&problem, 10.0, 80.0));
    assert!(detect(&problem, 25.0, 25.0));
}

#[test]
fn long_virtual_boards_preserve_tall_unit_separator_without_pole_failure() {
    let input = json!({
        "name": "long boards with tall thin seam", "strip_height": 30000,
        "items": [{"id": 0, "demand": 1, "allowed_orientations": [0],
            "shape": {"type": "rectangle", "data": {
                "x_min": 0, "y_min": 0, "width": 8, "height": 8}}}],
        "stock_geometry": {
            "outer": [[0,0],[120001,0],[120001,30000],[0,30000]],
            "boards": [
                {"outer": [[0,0],[60000,0],[60000,30000],[0,30000]]},
                {"outer": [[60001,0],[120001,0],[120001,30000],[60001,30000]]}
            ]
        }
    });
    let external: ExtSPInstance = serde_json::from_value(input.clone()).unwrap();
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, None, None);
    let instance = stock::apply(
        import_instance(&importer, &external).unwrap(),
        stock::parse(&input.to_string(), 30000.0).unwrap(),
    )
    .unwrap();
    let constraints = instance.stock_constraints.as_ref().unwrap();
    assert_eq!(constraints.max_width, 120001.0);
    assert_eq!(constraints.holes.area(), 30000.0);
    let problem = SPProblem::new(instance.clone());
    for (x, expected) in [(59990.0, false), (60000.0, true), (60010.0, false)] {
        let shape = instance
            .item(0)
            .shape_cd
            .transform_clone(&Transformation::from_translation((x, 15000.0)));
        assert_eq!(
            problem
                .layout
                .cde()
                .detect_poly_collision(&shape, &NoFilter),
            expected
        );
    }
}
