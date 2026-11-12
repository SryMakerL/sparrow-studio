#[path = "../src/stock.rs"]
mod stock;
#[path = "../src/warm_start.rs"]
mod warm_start;

use jagua_rs::io::import::Importer;
use jagua_rs::probs::spp::io::{ext_repr::ExtSPInstance, import_instance};
use rand::{SeedableRng, rngs::Xoshiro256PlusPlus};
use serde_json::json;
use sparrow::config::DEFAULT_SPARROW_CONFIG;

#[test]
fn long_virtual_stock_restores_initial_placement_without_relaxing_physical_limits() {
    let input = json!({
        "name": "long virtual warm start", "strip_height": 20, "stock_length": 160001,
        "items": [{"id": 0, "demand": 1, "allowed_orientations": [0],
            "shape": {"type": "rectangle", "data": {
                "x_min": 0, "y_min": 0, "width": 8, "height": 8}}}],
        "stock_geometry": {
            "outer": [[0,0],[160001,0],[160001,20],[0,20]],
            "boards": [
                {"outer": [[0,0],[80000,0],[80000,20],[0,20]]},
                {"outer": [[80001,0],[160001,0],[160001,20],[80001,20]]}
            ]
        },
        "initial_placement": {"used_length_mm": 160001, "placements": [
            {"item_id": 0, "rotation": 0, "translation": [80003,2]}
        ]}
    });
    let external: ExtSPInstance = serde_json::from_value(input.clone()).unwrap();
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, None, None);
    let instance = stock::apply(
        import_instance(&importer, &external).unwrap(),
        stock::parse(&input.to_string(), 20.0).unwrap(),
    )
    .unwrap();
    let warm = warm_start::parse(&input.to_string()).unwrap();
    let instance = warm_start::apply_stock_length(instance, &warm).unwrap();
    let solution = warm_start::construct(&instance, &warm, Xoshiro256PlusPlus::seed_from_u64(42))
        .unwrap()
        .unwrap();
    assert_eq!(solution.layout_snapshot.placed_items.len(), 1);
    assert!(warm_start::parse("{\"stock_length\":160001}").is_err());
}
