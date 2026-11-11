use super::*;
use std::ffi::CStr;

fn job() -> Value {
    json!({"name":"parity","parts":[{"id":"a","name":"A","source":{"format":"svg"},"outer":[[0,0],[4,0],[4,4],[0,4]],"holes":[],"approximationToleranceMm":0,"quantity":1,"priority":0,"rotations":{"kind":"discrete","degrees":[0]}}],"settings":{"materialWidthMm":20,"sheetLengthMm":20,"clearanceMm":1,"solverPreset":"fast","timeLimitSeconds":null,"sheetCompressionSeconds":1,"sheetInsertionFailures":1}})
}
fn placement(id: &str, x: f64, y: f64) -> Value {
    json!({"partId":id,"copyIndex":0,"xMm":x,"yMm":y,"angleDeg":0})
}
unsafe fn take(ptr: *mut c_char) -> Value {
    let v = serde_json::from_slice(unsafe { CStr::from_ptr(ptr) }.to_bytes()).unwrap();
    unsafe { sparrow_string_free(ptr) };
    v
}

#[test]
fn custom_total_seconds_validate_and_drive_deadline() {
    for seconds in [1, 7, 13, 47, 599, 600] {
        let mut input = job();
        input["settings"]["timeLimitSeconds"] = json!(seconds);
        assert_eq!(sheets::parse(&input.to_string()).unwrap().settings.time_limit_seconds, Some(seconds));
    }
    for invalid in [json!(0), json!(-1), json!(601), json!(1.5), json!("7")] {
        let mut input = job();
        input["settings"]["timeLimitSeconds"] = invalid;
        assert!(sheets::parse(&input.to_string()).is_err());
    }
    let mut input = job();
    input["settings"]["sheetCount"] = json!(1);
    input["settings"]["timeLimitSeconds"] = json!(2);
    let started = Instant::now();
    let result = solve(&input.to_string(), 1, 0, None).unwrap();
    assert!(started.elapsed() >= Duration::from_millis(1900));
    assert!(started.elapsed() < Duration::from_secs(6));
    assert!(result["unplaced"].as_array().unwrap().is_empty());
    assert_eq!(result["validation"]["status"], "passed");
}

#[test]
fn initial_search_defaults_and_fractional_settings_roundtrip() {
    let parsed = sheets::parse(&job().to_string()).unwrap();
    assert_eq!(parsed.settings.sheet_initial_search_seconds, None);
    assert_eq!(
        sheets::insertion_budget_ms(&parsed.settings, false, None),
        2500.0
    );
    assert!(
        serde_json::to_value(&parsed.settings)
            .unwrap()
            .get("sheetInitialSearchSeconds")
            .is_none()
    );
    let mut input = job();
    input["settings"]["sheetInitialSearchSeconds"] = Value::Null;
    let parsed = sheets::parse(&input.to_string()).unwrap();
    assert_eq!(
        sheets::insertion_budget_ms(&parsed.settings, false, None),
        2500.0
    );
    for seconds in [0.1, 0.125, 2.5, 600.0] {
        input["settings"]["sheetInitialSearchSeconds"] = json!(seconds);
        let parsed = sheets::parse(&input.to_string()).unwrap();
        assert_eq!(parsed.settings.sheet_initial_search_seconds, Some(seconds));
        assert_eq!(
            sheets::insertion_budget_ms(&parsed.settings, false, None),
            seconds * 1000.0
        );
        let serialized = serde_json::to_value(&parsed).unwrap();
        assert_eq!(serialized["settings"]["sheetInitialSearchSeconds"], seconds);
        assert_eq!(
            sheets::parse(&serialized.to_string())
                .unwrap()
                .settings
                .sheet_initial_search_seconds,
            Some(seconds)
        );
    }
}

#[test]
fn initial_search_rejects_invalid_seconds() {
    for seconds in [
        -1.0,
        0.0,
        0.099,
        600.001,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ] {
        let mut parsed = sheets::parse(&job().to_string()).unwrap();
        parsed.settings.sheet_initial_search_seconds = Some(seconds);
        assert!(validate(&parsed).is_err(), "{seconds}");
        if seconds.is_finite() {
            let mut input = job();
            input["settings"]["sheetInitialSearchSeconds"] = json!(seconds);
            assert!(sheets::parse(&input.to_string()).is_err(), "{seconds}");
        }
    }
    for bad in [json!("0.1"), json!(true), json!([])] {
        let mut input = job();
        input["settings"]["sheetInitialSearchSeconds"] = bad;
        assert!(sheets::parse(&input.to_string()).is_err());
    }
}

#[test]
fn configured_initial_and_warm_budgets_obey_global_remaining_time() {
    let mut input = job();
    input["settings"]["sheetInitialSearchSeconds"] = json!(0.125);
    input["settings"]["sheetInsertionWarmStartSeconds"] = json!(3);
    let parsed = sheets::parse(&input.to_string()).unwrap();
    assert_eq!(
        sheets::insertion_budget_ms(&parsed.settings, false, None),
        125.0
    );
    assert_eq!(
        sheets::insertion_budget_ms(&parsed.settings, true, None),
        3000.0
    );
    let end = Instant::now() + Duration::from_millis(50);
    for has_current in [false, true] {
        let budget = sheets::insertion_budget_ms(&parsed.settings, has_current, Some(end));
        assert!((0.0..=50.0).contains(&budget));
        assert_eq!(
            sheets::insertion_budget_ms(&parsed.settings, has_current, Some(Instant::now())),
            0.0
        );
    }
}

#[test]
fn single_fallback_uses_configured_initial_search_budget() {
    let mut input = job();
    input["settings"]["materialWidthMm"] = json!(4);
    input["settings"]["clearanceMm"] = json!(4);
    input["settings"]["solverPreset"] = json!("standard");
    input["settings"]["sheetInitialSearchSeconds"] = json!(0.1);
    let started = Instant::now();
    let result = solve(&input.to_string(), 1, 0, None).unwrap();
    assert_eq!(result["validation"]["status"], "passed");
    assert!(started.elapsed() >= Duration::from_millis(90));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn world_validation_does_not_round_rigid_translation_to_f32() {
    let mut input = job();
    input["parts"][0]["outer"] = json!([[0, 0], [0.001, 0], [0.001, 1], [0, 1]]);
    input["settings"]["sheetLengthMm"] = json!(60000);
    let parsed = sheets::parse(&input.to_string()).unwrap();
    let r = json!({"usedLengthMm":50001,"placements":[placement("a",50000.0,1.0)]});
    let checked = validation::check(&parsed, &r);
    assert_eq!(checked["status"], "passed", "{checked}");
}

#[test]
fn distant_complex_polygons_do_not_exhaust_clearance_segment_budget() {
    let mut input = job();
    input["settings"]["sheetLengthMm"] = json!(1000);
    let simple = input["parts"][0].clone();
    let mut b = simple.clone();
    b["id"] = json!("b");
    let circle: Ring = (0..8000)
        .map(|i| {
            let a = f64::from(i) * std::f64::consts::TAU / 8000.0;
            [10.0 + a.cos() * 5.0, 10.0 + a.sin() * 5.0]
        })
        .collect();
    let mut c = simple.clone();
    c["id"] = json!("c");
    c["outer"] = json!(circle);
    let mut d = c.clone();
    d["id"] = json!("d");
    input["parts"] = json!([simple, b, c, d]);
    let parsed = sheets::parse(&input.to_string()).unwrap();
    let checked = validation::check(
        &parsed,
        &json!({"usedLengthMm":1000,"placements":[placement("a",1.0,1.0),placement("b",6.0,1.0),placement("c",100.0,0.0),placement("d",300.0,0.0)]}),
    );
    assert_eq!(checked["status"], "passed", "{checked}");
    assert_eq!(checked["minClearanceMm"], 1.0);
}

#[test]
fn polygon_attempt_has_local_deadline_even_without_global_stop() {
    let mut input = job();
    input["settings"]["solverPreset"] = json!("standard");
    input["parts"][0]["outer"] = json!([[0, 0], [40, 0], [40, 40], [0, 40]]);
    let parsed = sheets::parse(&input.to_string()).unwrap();
    let started = Instant::now();
    assert!(polygon::run(&parsed, None, 1, 0, 10.0, &|| false).is_none());
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn complete_sheet_keeps_final_compression_window() {
    let mut input = job();
    input["settings"]["sheetCount"] = json!(1);
    let started = Instant::now();
    let r = solve(&input.to_string(), 1, 0, None).unwrap();
    assert!(r["unplaced"].as_array().unwrap().is_empty());
    assert!(started.elapsed() >= Duration::from_millis(950));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn completed_last_board_uses_entire_timed_budget() {
    for fallback in [false, true] {
        let mut input = job();
        input["settings"]["sheetCount"] = json!(1);
        input["settings"]["timeLimitSeconds"] = json!(10);
        if fallback {
            input["settings"]["materialWidthMm"] = json!(4);
            input["settings"]["clearanceMm"] = json!(4);
        }
        let started = Instant::now();
        let mut complete_frames = 0;
        let mut complete_seen = false;
        let r = sheets::run(&input.to_string(), 1, 0, None, &mut |event| {
            if event["type"] == "current-round"
                && event["result"]["unplaced"]
                    .as_array()
                    .is_some_and(Vec::is_empty)
            {
                complete_seen = true;
                complete_frames += 1;
            }
            if complete_seen && event["type"] == "progress" {
                assert_ne!(event["phase"], "Insertion");
            }
        })
        .unwrap();
        assert!(started.elapsed() >= Duration::from_millis(9900));
        assert!(started.elapsed() < Duration::from_secs(15));
        assert!(
            complete_frames > 1,
            "No ongoing compression previews; fallback={fallback}"
        );
        assert!(r["unplaced"].as_array().unwrap().is_empty());
        assert_eq!(r["validation"]["status"], "passed");
        assert_eq!(r["reason"], "Complete");
    }
}

#[test]
fn final_compression_can_be_cancelled_before_global_deadline() {
    let mut input = job();
    input["settings"]["sheetCount"] = json!(1);
    input["settings"]["timeLimitSeconds"] = json!(30);
    let token = Cancel {
        requested: AtomicBool::new(false),
    };
    let started = Instant::now();
    let mut complete_seen = false;
    let r = sheets::run(&input.to_string(), 1, 0, Some(&token), &mut |event| {
        if event["type"] == "current-round"
            && event["result"]["unplaced"]
                .as_array()
                .is_some_and(Vec::is_empty)
        {
            complete_seen = true;
        }
        if complete_seen && event["type"] == "progress" && event["phase"] == "Compression" {
            token.requested.store(true, Ordering::Release);
        }
    })
    .unwrap();
    assert!(complete_seen);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(r["reason"], "Stopped");
    assert!(r["unplaced"].as_array().unwrap().is_empty());
    assert_eq!(r["validation"]["status"], "passed");
}

#[test]
fn session_abi_keeps_zero_quantity_catalog_slot() {
    unsafe {
        let mut input = job();
        let mut zero = input["parts"][0].clone();
        zero["id"] = json!("zero");
        zero["quantity"] = json!(0);
        input["parts"].as_array_mut().unwrap().insert(0, zero);
        let input = CString::new(input.to_string()).unwrap();
        let created = take(abi::sparrow_session_create_json(input.as_ptr(), 0));
        let id = created["result"]["sessionId"].as_u64().unwrap();
        let request =
            CString::new(json!({"quantities":[0,1],"mode":"search"}).to_string()).unwrap();
        let result = take(abi::sparrow_session_step_json(id, request.as_ptr(), 1));
        abi::sparrow_session_free(id);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["result"]["placements"][0]["partId"], "a");
    }
}
