use super::*;

fn job() -> Value {
    json!({
        "name":"automatic",
        "parts":[{"id":"part","name":"Part","source":{"format":"svg"},
            "outer":[[0,0],[10,0],[10,10],[0,10]],"holes":[],
            "approximationToleranceMm":0,"quantity":3,"priority":0,
            "rotations":{"kind":"discrete","degrees":[0]}}],
        "settings":{"materialWidthMm":12,"sheetLengthMm":12,"clearanceMm":0,
            "timeLimitSeconds":null,"solverPreset":"fast","autoAddSheets":true,
            "sheetInitialSearchSeconds":0.1,"sheetInsertionWarmStartSeconds":1,
            "sheetCompressionSeconds":1,"sheetInsertionFailures":1}
    })
}

fn stock(polygon: bool) -> Value {
    let mut stock = json!({"id":"board","name":"Board","quantity":1,"priority":0,
        "widthMm":12,"lengthMm":12,"kind":"rectangle"});
    if polygon {
        stock["kind"] = json!("polygon");
        stock["outer"] = json!([[0, 0], [12, 0], [12, 12], [0, 12]]);
        stock["holes"] = json!([[[11, 11], [11.5, 11], [11.5, 11.5], [11, 11.5]]]);
        stock["approximationToleranceMm"] = json!(0);
    }
    stock
}

#[test]
fn automatic_no_count_expands_identical_legacy_rectangle_and_polygon_stock() {
    for snapshot in [None, Some(stock(false)), Some(stock(true))] {
        let mut input = job();
        if let Some(snapshot) = snapshot {
            input["settings"]["sheetStock"] = snapshot;
        }
        let parsed = sheets::parse(&input.to_string()).unwrap();
        let expected = serde_json::to_value(&sheets::stocks(&parsed)[0]).unwrap();
        let result = solve(&input.to_string(), 42, 8, None).unwrap();
        assert_eq!(result["reason"], "Complete", "{result}");
        assert_eq!(result["validation"]["status"], "passed");
        assert_eq!(result["sheets"].as_array().unwrap().len(), 3);
        assert_eq!(result["unplaced"], json!([]));
        for sheet in result["sheets"].as_array().unwrap() {
            let settings = &sheet["job"]["settings"];
            assert!(settings.get("autoAddSheets").is_none());
            assert!(settings.get("sheetCount").is_none());
            assert!(settings.get("sheetStocks").is_none());
            assert_eq!(settings["sheetStock"], expected);
            assert_eq!(sheet["result"]["placements"].as_array().unwrap().len(), 1);
        }
        assert_eq!(validation::check(&parsed, &result)["status"], "passed");
    }
}

#[test]
fn finite_one_sheet_stays_partial_and_false_is_omitted() {
    let mut input = job();
    input["settings"]["autoAddSheets"] = json!(false);
    input["settings"]["sheetCount"] = json!(1);
    let parsed = sheets::parse(&input.to_string()).unwrap();
    assert!(
        serde_json::to_value(&parsed.settings)
            .unwrap()
            .get("autoAddSheets")
            .is_none()
    );
    let result = solve(&input.to_string(), 42, 0, None).unwrap();
    assert_eq!(result["sheets"].as_array().unwrap().len(), 1);
    assert_eq!(result["unplaced"], json!([{"partId":"part","quantity":2}]));
    assert_eq!(result["reason"], "StockExhausted");
    input["settings"]
        .as_object_mut()
        .unwrap()
        .remove("autoAddSheets");
    assert!(
        !sheets::parse(&input.to_string())
            .unwrap()
            .settings
            .auto_add_sheets
    );
}

#[test]
fn automatic_empty_boards_stop_after_two_consecutive_attempts_per_round() {
    let mut input = job();
    input["settings"]["materialWidthMm"] = json!(2);
    input["settings"]["sheetLengthMm"] = json!(2);
    let mut attempts = 0;
    let result = sheets::run(&input.to_string(), 42, 0, None, &mut |event| {
        if event["type"] == "progress" && event["phase"] == "Insertion" {
            attempts += 1;
        }
    })
    .unwrap();
    assert_eq!(attempts, 6);
    assert_eq!(result["reason"], "Unplaceable");
    assert_eq!(result["sheets"], json!([]));
    assert_eq!(result["unplaced"][0]["quantity"], 3);
    assert_eq!(result["validation"]["status"], "passed");
}

#[test]
fn automatic_rejects_ambiguous_or_unbounded_specifications() {
    for mutation in 0..6 {
        let mut input = job();
        match mutation {
            0 => input["settings"]["sheetCount"] = json!(1),
            1 => input["settings"]["sheetStocks"] = json!([stock(false)]),
            2 => {
                input["settings"]
                    .as_object_mut()
                    .unwrap()
                    .remove("sheetLengthMm");
            }
            3 => input["settings"]["autoAddSheets"] = json!("true"),
            4 => {
                input["settings"]["sheetStock"] = {
                    let mut s = stock(false);
                    s["widthMm"] = json!(13);
                    s
                }
            }
            _ => {
                input["parts"][0]["quantity"] = json!(usize::MAX);
                let mut other = input["parts"][0].clone();
                other["id"] = json!("other");
                input["parts"].as_array_mut().unwrap().push(other);
            }
        }
        assert!(
            sheets::parse(&input.to_string()).is_err(),
            "mutation {mutation}"
        );
    }
}

#[test]
fn automatic_validation_rejects_forged_snapshots_dimensions_demand_and_empty_sheets() {
    let mut input = job();
    input["settings"]["sheetStock"] = stock(true);
    let parsed = sheets::parse(&input.to_string()).unwrap();
    let result = solve(&input.to_string(), 42, 0, None).unwrap();
    for mutation in 0..9 {
        let mut bad = result.clone();
        match mutation {
            0 => bad["sheets"][0]["job"]["settings"]["materialWidthMm"] = json!(13),
            1 => bad["sheets"][0]["job"]["settings"]["sheetLengthMm"] = json!(13),
            2 => bad["sheets"][0]["job"]["settings"]["sheetStock"]["id"] = json!("forged"),
            3 => bad["sheets"][0]["job"]["settings"]["sheetStock"]["quantity"] = json!(99),
            4 => bad["sheets"][0]["job"]["settings"]["sheetStock"]["holes"] = json!([]),
            5 => bad["unplaced"] = json!([{"partId":"part","quantity":1}]),
            6 => bad["sheets"][0]["job"]["settings"]["autoAddSheets"] = json!(true),
            7 => {
                let extra = bad["sheets"][0].clone();
                bad["sheets"].as_array_mut().unwrap().push(extra);
                bad["usedLengthMm"] = json!(
                    bad["usedLengthMm"].as_f64().unwrap()
                        + bad["sheets"][0]["result"]["usedLengthMm"].as_f64().unwrap()
                );
            }
            _ => {
                bad["sheets"][0]["job"]["parts"][0]["quantity"] = json!(0);
                bad["sheets"][0]["result"]["placements"] = json!([]);
                bad["unplaced"] = json!([{"partId":"part","quantity":1}]);
            }
        }
        assert_eq!(
            validation::check(&parsed, &bad)["status"],
            "failed",
            "mutation {mutation}"
        );
    }
    let mut finite = input;
    finite["settings"]["autoAddSheets"] = json!(false);
    finite["settings"]["sheetCount"] = json!(1);
    assert_eq!(
        validation::check(&sheets::parse(&finite.to_string()).unwrap(), &result)["status"],
        "failed"
    );
}

#[test]
fn automatic_kernel_and_step_catalogs_are_rejected() {
    let input = job();
    assert!(kernel::Kernel::new(sheets::parse(&input.to_string()).unwrap()).is_err());
    unsafe {
        let input = CString::new(input.to_string()).unwrap();
        let created = abi::sparrow_session_create_json(input.as_ptr(), 0);
        let value: Value =
            serde_json::from_slice(std::ffi::CStr::from_ptr(created).to_bytes()).unwrap();
        sparrow_string_free(created);
        let id = value["result"]["sessionId"].as_u64().unwrap();
        let request = CString::new(json!({"quantities":[1],"mode":"search"}).to_string()).unwrap();
        let response = abi::sparrow_session_step_json(id, request.as_ptr(), 42);
        let value: Value =
            serde_json::from_slice(std::ffi::CStr::from_ptr(response).to_bytes()).unwrap();
        sparrow_string_free(response);
        abi::sparrow_session_free(id);
        assert_eq!(value["ok"], false);
        assert!(value["error"].as_str().unwrap().contains("aggregate"));
    }
}

#[test]
fn automatic_stop_keeps_valid_current_preview() {
    let token = Cancel {
        requested: AtomicBool::new(false),
    };
    let mut current = false;
    let result = sheets::run(&job().to_string(), 42, 0, Some(&token), &mut |event| {
        if event["type"] == "current-round" {
            current = true;
        }
        if event["type"] == "candidate" {
            token.requested.store(true, Ordering::Relaxed);
        }
    })
    .unwrap();
    assert!(current);
    assert_eq!(result["reason"], "Stopped");
    assert_eq!(result["validation"]["status"], "passed");
    assert_eq!(result["sheets"].as_array().unwrap().len(), 1);
}
