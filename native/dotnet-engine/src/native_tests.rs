use super::*;
use std::ffi::CStr;

fn job() -> Value {
    json!({"name":"native","parts":[{"id":"a","name":"A","source":{"format":"svg"},"outer":[[0,0],[10,0],[10,10],[0,10]],"holes":[],"approximationToleranceMm":0,"quantity":3,"priority":0,"rotations":{"kind":"discrete","degrees":[0]}}],"settings":{"materialWidthMm":12,"clearanceMm":0,"timeLimitSeconds":null,"solverPreset":"fast","sheetLengthMm":12,"sheetCount":2,"sheetCompressionSeconds":1,"sheetInsertionWarmStartSeconds":1,"sheetInsertionFailures":1}})
}
fn stock(id: &str, priority: i32, width: f64, length: f64, quantity: usize) -> Value {
    json!({"id":id,"name":id,"kind":"rectangle","priority":priority,"widthMm":width,"lengthMm":length,"quantity":quantity})
}
fn single() -> Value {
    let mut j = job();
    j["settings"].as_object_mut().unwrap().remove("sheetCount");
    j["parts"][0]["quantity"] = json!(1);
    j
}
unsafe fn take(ptr: *mut c_char) -> Value {
    assert!(!ptr.is_null());
    let value = serde_json::from_slice(unsafe { CStr::from_ptr(ptr) }.to_bytes()).unwrap();
    unsafe { sparrow_string_free(ptr) };
    value
}
fn layout(placements: Value) -> Value {
    json!({"usedLengthMm":12,"placements":placements})
}
fn placement(id: &str, copy: usize, x: f64, y: f64, angle: f64) -> Value {
    json!({"partId":id,"copyIndex":copy,"xMm":x,"yMm":y,"angleDeg":angle})
}

#[test]
fn finite_inventory_returns_partial_and_conserves_quantities() {
    let j = job();
    let r = solve(&j.to_string(), 42, 9, None).unwrap();
    assert_eq!(r["sheets"].as_array().unwrap().len(), 2);
    assert_eq!(r["unplaced"], json!([{"partId":"a","quantity":1}]));
    assert_eq!(r["reason"], "StockExhausted");
    assert_eq!(r["validation"]["status"], "passed");
    assert_eq!(
        validation::check(&sheets::parse(&j.to_string()).unwrap(), &r)["status"],
        "passed"
    );
    assert!(
        r["sheets"][0]["job"]["settings"]
            .get("sheetCount")
            .is_none()
    );
}
#[test]
fn inventory_and_parts_obey_priority() {
    let mut j = job();
    j["parts"][0]["quantity"] = json!(1);
    let mut high = j["parts"][0].clone();
    high["id"] = json!("high");
    high["priority"] = json!(9);
    j["parts"].as_array_mut().unwrap().push(high);
    j["settings"]["sheetStocks"] = json!([
        stock("low", 0, 12.0, 12.0, 1),
        stock("preferred", 99, 12.0, 12.0, 1)
    ]);
    let r = solve(&j.to_string(), 42, 0, None).unwrap();
    assert!(r["unplaced"].as_array().unwrap().is_empty());
    assert_eq!(
        r["sheets"][0]["job"]["settings"]["sheetStock"]["id"],
        "preferred"
    );
    assert_eq!(r["sheets"][0]["result"]["placements"][0]["partId"], "high");
}
#[test]
fn unplaceable_is_a_valid_empty_partial_result() {
    let mut j = job();
    j["settings"]["sheetStocks"] = json!([stock("tiny", 0, 2.0, 2.0, 1)]);
    let r = solve(&j.to_string(), 1, 0, None).unwrap();
    assert!(r["sheets"].as_array().unwrap().is_empty());
    assert_eq!(r["unplaced"][0]["quantity"], 3);
    assert_eq!(r["validation"]["status"], "passed");
    assert_eq!(r["reason"], "Unplaceable");
}
#[test]
fn cancelled_aggregate_preserves_best_candidate() {
    let token = Cancel {
        requested: AtomicBool::new(false),
    };
    let mut events = 0;
    let r = sheets::run(&job().to_string(), 42, 0, Some(&token), &mut |e| {
        if e["type"] == "candidate" {
            events += 1;
            token.requested.store(true, Ordering::Release);
        }
    })
    .unwrap();
    assert!(events > 0);
    assert_eq!(r["reason"], "Stopped");
    assert!(!r["sheets"].as_array().unwrap().is_empty());
    assert_eq!(r["validation"]["status"], "passed");
}
#[test]
fn precancelled_aggregate_returns_accounted_empty_result() {
    let token = Cancel {
        requested: AtomicBool::new(true),
    };
    let r = solve(&job().to_string(), 1, 0, Some(&token)).unwrap();
    assert_eq!(r["reason"], "Stopped");
    assert_eq!(r["unplaced"][0]["quantity"], 3);
}
#[test]
fn narrow_rectangular_stock_does_not_inset_by_clearance() {
    let mut j = job();
    j["settings"]["materialWidthMm"] = json!(10);
    j["settings"]["sheetLengthMm"] = json!(35);
    j["settings"]["sheetCount"] = json!(1);
    j["settings"]["clearanceMm"] = json!(12);
    j["parts"][0]["quantity"] = json!(2);
    let r = solve(&j.to_string(), 1, 0, None).unwrap();
    assert!(r["unplaced"].as_array().unwrap().is_empty(), "{r}");
    assert!(
        r["sheets"][0]["result"]["validation"]["minClearanceMm"]
            .as_f64()
            .unwrap()
            >= 12.0 - 1e-6
    );
}
#[test]
fn geometry_rejects_overlap_clearance_boundary_rotation_and_duplicate() {
    let mut j = single();
    j["parts"][0]["quantity"] = json!(2);
    j["settings"]["materialWidthMm"] = json!(40);
    j["settings"]["sheetLengthMm"] = json!(40);
    let parsed = sheets::parse(&j.to_string()).unwrap();
    for p in [
        json!([
            placement("a", 0, 0.0, 0.0, 0.0),
            placement("a", 1, 0.0, 0.0, 0.0)
        ]),
        json!([
            placement("a", 0, 0.0, 0.0, 0.0),
            placement("a", 0, 12.0, 0.0, 0.0)
        ]),
        json!([
            placement("a", 0, 0.0, 0.0, 0.0),
            placement("a", 1, 12.0, 0.0, 45.0)
        ]),
        json!([
            placement("a", 0, -1.0, 0.0, 0.0),
            placement("a", 1, 12.0, 0.0, 0.0)
        ]),
    ] {
        assert_eq!(
            validation::check(&parsed, &json!({"usedLengthMm":40,"placements":p}))["status"],
            "failed"
        );
    }
    j["settings"]["clearanceMm"] = json!(3);
    let parsed = sheets::parse(&j.to_string()).unwrap();
    let r = json!({"usedLengthMm":40,"placements":[placement("a",0,0.0,0.0,0.0),placement("a",1,12.0,0.0,0.0)]});
    assert_eq!(validation::check(&parsed, &r)["status"], "failed");
}
#[test]
fn polygon_stock_holes_are_independently_enforced() {
    let mut j = single();
    j["settings"]["sheetLengthMm"] = json!(40);
    j["settings"]["materialWidthMm"] = json!(40);
    let mut s = stock("shape", 0, 40.0, 40.0, 1);
    s["kind"] = json!("polygon");
    s["outer"] = json!([[0, 0], [40, 0], [40, 40], [0, 40]]);
    s["holes"] = json!([[[10, 10], [25, 10], [25, 25], [10, 25]]]);
    j["settings"]["sheetStock"] = s;
    let parsed = sheets::parse(&j.to_string()).unwrap();
    let bad = json!({"usedLengthMm":40,"placements":[placement("a",0,12.0,12.0,0.0)]});
    assert_eq!(validation::check(&parsed, &bad)["status"], "failed");
    let good = json!({"usedLengthMm":40,"placements":[placement("a",0,0.0,0.0,0.0)]});
    assert_eq!(validation::check(&parsed, &good)["status"], "passed");
}
#[test]
fn invalid_inventory_inputs_are_rejected() {
    for stocklist in [
        json!([]),
        json!([stock("a", 0, 12.0, 12.0, 0)]),
        json!([stock("a", 1000, 12.0, 12.0, 1)]),
        json!([stock("a", 0, 12.0, 12.0, 1), stock("a", 0, 12.0, 12.0, 1)]),
    ] {
        let mut j = job();
        j["settings"]["sheetStocks"] = stocklist;
        assert!(sheets::parse(&j.to_string()).is_err());
    }
}
#[test]
fn zero_demand_does_not_corrupt_catalog_identity() {
    let mut j = single();
    let mut zero = j["parts"][0].clone();
    zero["id"] = json!("zero");
    zero["quantity"] = json!(0);
    j["parts"].as_array_mut().unwrap().insert(0, zero);
    let mut k = kernel::Kernel::new(sheets::parse(&j.to_string()).unwrap()).unwrap();
    let r = k
        .step(
            &json!({"quantities":[0,1],"mode":"search"}),
            1,
            0,
            None,
            &mut |_| {},
        )
        .unwrap();
    assert_eq!(r["placements"][0]["partId"], "a");
}
#[test]
fn snapshots_restore_insert_retain_expire_and_reject_shrink() {
    let mut j = single();
    j["settings"]["materialWidthMm"] = json!(40);
    j["settings"]["sheetLengthMm"] = json!(60);
    let mut k = kernel::Kernel::new(sheets::parse(&j.to_string()).unwrap()).unwrap();
    let a = k
        .step(
            &json!({"quantities":[1],"mode":"search"}),
            1,
            0,
            None,
            &mut |_| {},
        )
        .unwrap();
    let id = a["snapshotId"].clone();
    let b = k
        .step(
            &json!({"quantities":[2],"mode":"search","initial_snapshot":id,"retain_snapshot":id}),
            2,
            0,
            None,
            &mut |_| {},
        )
        .unwrap();
    assert_eq!(b["placements"].as_array().unwrap().len(), 2);
    assert!(
        k.step(
            &json!({"quantities":[1],"mode":"search","initial_snapshot":b["snapshotId"]}),
            2,
            0,
            None,
            &mut |_| {}
        )
        .is_err()
    );
    assert!(
        k.step(
            &json!({"quantities":[2],"mode":"search","initial_snapshot":id}),
            2,
            0,
            None,
            &mut |_| {}
        )
        .unwrap_err()
        .contains("expired")
    );
}
#[test]
fn cancellation_during_candidate_keeps_valid_strip_result() {
    let j = sheets::parse(&single().to_string()).unwrap();
    let token = Cancel {
        requested: AtomicBool::new(false),
    };
    let mut k = kernel::Kernel::new(j).unwrap();
    let r = k
        .step(
            &json!({"quantities":[1],"mode":"continuous","budget_ms":10000}),
            1,
            0,
            Some(&token),
            &mut |e| {
                if e["type"] == "candidate" {
                    token.requested.store(true, Ordering::Release);
                }
            },
        )
        .unwrap();
    assert_eq!(r["cancelled"], true);
    assert_eq!(r["validation"]["status"], "passed");
}
#[test]
fn invalid_session_requests_rejected() {
    let mut k = kernel::Kernel::new(sheets::parse(&single().to_string()).unwrap()).unwrap();
    for request in [
        json!({"quantities":[],"mode":"search"}),
        json!({"quantities":[0],"mode":"search"}),
        json!({"quantities":[1],"mode":"invalid"}),
        json!({"quantities":[1],"mode":"search","budget_ms":-1}),
        json!({"quantities":[1],"mode":"search","initial_snapshot":999}),
    ] {
        assert!(k.step(&request, 1, 0, None, &mut |_| {}).is_err());
    }
}
#[test]
fn independent_validation_abi_roundtrip() {
    unsafe {
        let j = CString::new(single().to_string()).unwrap();
        let r =
            CString::new(layout(json!([placement("a", 0, 0.0, 0.0, 0.0)])).to_string()).unwrap();
        assert_eq!(
            take(abi::sparrow_validate_json(j.as_ptr(), r.as_ptr()))["result"]["status"],
            "passed"
        );
        assert_eq!(
            take(abi::sparrow_validate_json(std::ptr::null(), r.as_ptr()))["ok"],
            false
        );
    }
}
#[test]
fn session_abi_poll_cancel_free_are_concurrent_and_idempotent() {
    unsafe {
        let input = CString::new(job().to_string()).unwrap();
        let created = take(abi::sparrow_session_create_json(input.as_ptr(), 7));
        let id = created["result"]["sessionId"].as_u64().unwrap();
        assert_eq!(take(abi::sparrow_session_start_json(id, 42))["ok"], true);
        let mut workers = Vec::new();
        for _ in 0..4 {
            workers.push(std::thread::spawn(move || {
                abi::sparrow_session_cancel(id);
                let p = abi::sparrow_session_poll_json(id);
                let v = take(p);
                assert_eq!(v["ok"], true);
            }));
        }
        for w in workers {
            w.join().unwrap();
        }
        abi::sparrow_session_free(id);
        abi::sparrow_session_free(id);
        abi::sparrow_session_cancel(id);
        assert_eq!(take(abi::sparrow_session_poll_json(id))["ok"], false);
    }
}
#[test]
fn session_abi_steps_and_polling() {
    unsafe {
        let input = CString::new(single().to_string()).unwrap();
        let id = take(abi::sparrow_session_create_json(input.as_ptr(), 3))["result"]["sessionId"]
            .as_u64()
            .unwrap();
        let request = CString::new(json!({"quantities":[1],"mode":"search"}).to_string()).unwrap();
        let r = take(abi::sparrow_session_step_json(id, request.as_ptr(), 42));
        assert_eq!(r["ok"], true, "{r}");
        let poll = take(abi::sparrow_session_poll_json(id));
        assert_eq!(poll["result"]["status"], "finished");
        assert!(!poll["result"]["events"].as_array().unwrap().is_empty());
        assert_eq!(
            take(abi::sparrow_session_poll_json(id))["result"]["events"],
            json!([])
        );
        abi::sparrow_session_free(id);
    }
}
