use super::*;
use jagua_rs::Instant;
use jagua_rs::io::import::Importer;
use jagua_rs::probs::spp::io::{export, import_instance, ext_repr::ExtSPInstance};
use rand::SeedableRng;
use serde_json::{Value, json};
use sparrow::config::DEFAULT_SPARROW_CONFIG;

fn input() -> Value {
    json!({"name":"warm", "strip_height":100,
        "stock_length":160,
        "items":[{"id":0,"demand":2,"allowed_orientations":[0,90],
            "shape":{"type":"rectangle","data":{"x_min":7,"y_min":-3,"width":20,"height":10}}},
            {"id":1,"demand":1,"allowed_orientations":[0],
            "shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":12,"height":12}}}],
        "initial_placement":{"used_length_mm":70,"placements":[
            {"item_id":0,"rotation":90,"translation":[40,10]}]}})
}

fn setup(value: &Value) -> Result<(SPInstance, Input), String> {
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, Some(2.0), None);
    let external: ExtSPInstance = serde_json::from_value(value.clone()).unwrap();
    let instance = import_instance(&importer, &external).unwrap();
    let instance = crate::stock::apply(instance, crate::stock::parse(&value.to_string(), 100.0)? )?;
    let parsed = parse(&value.to_string())?;
    Ok((apply_stock_length(instance, &parsed)?, parsed))
}

fn run(value: &Value) -> Result<SPSolution, String> {
    let (instance, parsed) = setup(value)?;
    construct(&instance, &parsed, Xoshiro256PlusPlus::seed_from_u64(42))?
        .ok_or_else(|| "No warm input".into())
}

#[test]
fn restores_external_rotation_and_non_origin_coordinates_with_clearance_and_inserts_missing_demands() {
    let value = input();
    let (instance, parsed) = setup(&value).unwrap();
    let epoch = Instant::now();
    let solution = construct(&instance, &parsed, Xoshiro256PlusPlus::seed_from_u64(42)).unwrap().unwrap();
    let output = export(&instance, &solution, epoch);
    assert_eq!(output.layout.placed_items.len(), 3);
    assert_eq!(output.layout.placed_items.iter().filter(|p| p.item_id == 0).count(), 2);
    let old = output.layout.placed_items.iter().find(|p| {
        let (x, y) = p.transformation.translation;
        (x - 40.0).abs() < 1e-4 && (y - 10.0).abs() < 1e-4
    }).expect("old external coordinates must remain unchanged during insertion");
    assert!((old.transformation.rotation - 90.0).abs() < 1e-4);
    assert!(solution.strip.width <= 160.0);
    let mut prob = SPProblem::new(instance);
    prob.restore(&solution);
    assert_eq!(prob.item_demand_qtys, vec![0, 0]);
    assert!(prob.layout.is_feasible());
}

#[test]
fn preserves_static_hazards_and_rejects_old_parts_inside_holes() {
    let mut value = input();
    value["stock_geometry"] = json!({"outer":[[0,0],[160,0],[160,100],[0,100]],
        "holes":[[[80,30],[110,30],[110,70],[80,70]]]});
    let solution = run(&value).unwrap();
    let holes = &solution.layout_snapshot.container.quality_zones[0].as_ref().unwrap().shapes_cd;
    assert!(!holes.is_empty());
    assert_eq!(holes[0].bbox.x_min, 80.0);
    value["initial_placement"]["used_length_mm"] = json!(150);
    value["initial_placement"]["placements"][0]["translation"] = json!([90,35]);
    assert!(run(&value).unwrap_err().contains("collides"));
}

#[test]
fn inserts_with_full_stock_length_before_fitting() {
    let mut value = input();
    value["items"] = json!([{"id":0,"demand":2,"allowed_orientations":[0],
        "shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":50,"height":80}}}]);
    value["initial_placement"] = json!({"used_length_mm":56,"placements":[
        {"item_id":0,"rotation":0,"translation":[3,3]}]});
    let solution = run(&value).unwrap();
    assert!(solution.strip.width > 100.0);
    value["stock_length"] = json!(60);
    assert!(run(&value).unwrap_err().contains("insertion failed"));
}

#[test]
fn restores_at_full_stock_width_instead_of_treating_used_length_as_a_wall() {
    let mut value = input();
    value["items"] = json!([{"id":0,"demand":2,"allowed_orientations":[0],
        "shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":50,"height":80}}}]);
    value["initial_placement"] = json!({"used_length_mm":53,"placements":[
        {"item_id":0,"rotation":0,"translation":[3,3]}]});
    let solution = run(&value).unwrap();
    assert_eq!(solution.layout_snapshot.placed_items.len(), 2);
    assert!(solution.strip.width > 100.0);
}

#[test]
fn rejects_bad_ids_counts_angles_lengths_and_collisions() {
    for (field, invalid) in [("item_id", json!(99)), ("rotation", json!(45)),
        ("rotation", json!(1e100)), ("translation", json!([1e100, 10])),
        ("translation", json!([-100, 10]))] {
        let mut value = input();
        value["initial_placement"]["placements"][0][field] = invalid;
        assert!(run(&value).is_err(), "{field}: {value}");
    }
    for length in [0, -1, 161] {
        let mut value = input();
        value["initial_placement"]["used_length_mm"] = json!(length);
        assert!(run(&value).is_err());
    }
    let mut value = input();
    let placement = value["initial_placement"]["placements"][0].clone();
    value["initial_placement"]["placements"] = json!([placement, placement, placement]);
    assert!(run(&value).is_err());
    value["initial_placement"]["placements"] = json!([]);
    assert!(run(&value).is_err());
    value["stock_length"] = json!(0);
    assert!(setup(&value).is_err());
}

#[test]
fn absent_warm_input_leaves_the_original_unbounded_instance_unchanged() {
    let mut value = input();
    value.as_object_mut().unwrap().remove("initial_placement");
    value.as_object_mut().unwrap().remove("stock_length");
    let (instance, parsed) = setup(&value).unwrap();
    assert!(instance.stock_constraints.is_none());
    assert!(construct(&instance, &parsed, Xoshiro256PlusPlus::seed_from_u64(42)).unwrap().is_none());
}
