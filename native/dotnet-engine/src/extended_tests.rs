use super::*;

fn job() -> Value {
    json!({"name":"mixed","parts":[{"id":"part","name":"Part","source":{"format":"dxf"},"outer":[[0,0],[4,0],[4,4],[0,4]],"holes":[],"quantity":2,"priority":2,"approximationToleranceMm":0,"rotations":{"kind":"discrete","degrees":[0,90]}}],"settings":{"materialWidthMm":20,"clearanceMm":1,"timeLimitSeconds":null,"solverPreset":"fast","sheetLengthMm":20,"sheetCount":1,"sheetCompressionSeconds":1,"sheetInsertionFailures":1,"sheetStocks":[{"id":"polygon","name":"Polygon","kind":"polygon","quantity":1,"priority":10,"widthMm":20,"lengthMm":20,"outer":[[10,10],[30,10],[30,25],[25,30],[10,30]],"holes":[[[18,18],[22,18],[22,22],[18,22]]]}]}})
}

#[test]
fn translated_polygon_inventory_normalizes_and_solves() {
    let input = job();
    let parsed = sheets::parse(&input.to_string()).unwrap();
    let stock = &parsed.settings.sheet_stocks.as_ref().unwrap()[0];
    assert_eq!(stock.length_mm, 20.0);
    let result = solve(&input.to_string(), 21, 4, None).unwrap();
    assert_eq!(result["validation"]["status"], "passed");
    assert!(
        result["unplaced"].as_array().unwrap().is_empty(),
        "{result}"
    );
    assert_eq!(validation::check(&parsed, &result)["status"], "passed");
}

#[test]
fn aggregate_rejects_inventory_identity_demand_and_length_tampering() {
    let input = job();
    let parsed = sheets::parse(&input.to_string()).unwrap();
    let result = solve(&input.to_string(), 21, 4, None).unwrap();
    for mutation in 0..4 {
        let mut bad = result.clone();
        match mutation {
            0 => bad["sheets"][0]["job"]["settings"]["sheetStock"]["priority"] = json!(0),
            1 => bad["sheets"][0]["job"]["parts"][0]["outer"][0][0] = json!(1),
            2 => bad["unplaced"] = json!([{"partId":"part","quantity":1}]),
            _ => bad["usedLengthMm"] = json!(99),
        }
        assert_eq!(validation::check(&parsed, &bad)["status"], "failed");
    }
}

#[test]
fn session_external_initial_placement_inserts_missing_copy() {
    let mut input = job();
    input["settings"]
        .as_object_mut()
        .unwrap()
        .remove("sheetStocks");
    input["settings"]
        .as_object_mut()
        .unwrap()
        .remove("sheetCount");
    let mut kernel = kernel::Kernel::new(sheets::parse(&input.to_string()).unwrap()).unwrap();
    let result=kernel.step(&json!({"quantities":[2],"mode":"search","initial_placement":{"used_length_mm":6,"placements":[{"item_id":0,"rotation":0,"translation":[1.1,1.1]}]}}),2,0,None,&mut |_|{}).unwrap();
    assert_eq!(result["placements"].as_array().unwrap().len(), 2);
    assert_eq!(result["validation"]["status"], "passed");
}

#[test]
fn bounded_compression_retains_valid_snapshot() {
    let mut input = job();
    input["settings"]
        .as_object_mut()
        .unwrap()
        .remove("sheetStocks");
    input["settings"]
        .as_object_mut()
        .unwrap()
        .remove("sheetCount");
    let mut kernel = kernel::Kernel::new(sheets::parse(&input.to_string()).unwrap()).unwrap();
    let first = kernel
        .step(
            &json!({"quantities":[2],"mode":"search"}),
            2,
            0,
            None,
            &mut |_| {},
        )
        .unwrap();
    let result=kernel.step(&json!({"quantities":[2],"mode":"compress","budget_ms":20,"initial_snapshot":first["snapshotId"]}),3,0,None,&mut |_|{}).unwrap();
    assert_eq!(result["validation"]["status"], "passed");
    assert!(result["usedLengthMm"].as_f64() <= first["usedLengthMm"].as_f64());
}
