use super::*;
use jagua_rs::entities::Layout;
use std::sync::Arc;

fn session() -> SheetSession {
    SheetSession::create(&json!({"name":"session", "strip_height":50, "stock_length":120,
        "stock_geometry":{"outer":[[0,0],[120,0],[120,50],[0,50]],"holes":[[[100,30],[110,30],[110,40],[100,40]]]},
        "items":[
            {"id":0,"demand":2,"allowed_orientations":[0],"shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":20,"height":20}}},
            {"id":1,"demand":1,"allowed_orientations":[0],"shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":12,"height":12}}}
        ]}).to_string(), 1.0, "fast").unwrap()
}

fn request(quantities: &[usize], initial: Option<u32>, retain: Option<u32>, mode: &str) -> String {
    json!({"quantities":quantities,"initial_snapshot":initial,"retain_snapshot":retain,
        "mode":mode,"budget_ms":0})
    .to_string()
}

fn step(session: &mut SheetSession, input: &str) -> Result<Vec<Value>, String> {
    let request = session.parse_request(input)?;
    let mut terminator = SessionTerminator::new(&request, None);
    let mut messages = vec![];
    session.execute(request, 42, &mut terminator, |value| messages.push(value))?;
    Ok(messages)
}

fn external(candidate: &Value) -> Value {
    json!({"used_length_mm":candidate["solution"]["strip_width"],
        "placements":candidate["solution"]["layout"]["placed_items"].as_array().unwrap().iter().map(|item| json!({
            "item_id":item["item_id"], "rotation":item["transformation"]["rotation"],
            "translation":item["transformation"]["translation"]
        })).collect::<Vec<_>>()})
}

#[test]
fn external_layout_recovers_after_compression_and_expiry_then_restores_deleted_subset() {
    let mut original_session = session();
    let first = candidate(
        &step(
            &mut original_session,
            &request(&[1, 0], None, None, "search"),
        )
        .unwrap(),
    );
    let compressed = step(
        &mut original_session,
        &request(&[1, 0], Some(first), None, "compress"),
    )
    .unwrap();
    let layout = external(
        compressed
            .iter()
            .find(|m| m["type"] == "candidate")
            .unwrap(),
    );
    let mut recovered = session();
    assert!(
        step(&mut recovered, &request(&[2, 1], Some(999), None, "search"))
            .unwrap_err()
            .contains("Unknown or expired snapshot")
    );
    let input =
        json!({"quantities":[2,1], "initial_placement":layout, "mode":"search", "budget_ms":0});
    let messages = step(&mut recovered, &input.to_string()).unwrap();
    let expanded = messages.iter().find(|m| m["type"] == "candidate").unwrap();
    let expanded_layout = external(expanded);
    for placement in layout["placements"].as_array().unwrap() {
        assert!(
            expanded_layout["placements"]
                .as_array()
                .unwrap()
                .contains(placement)
        );
    }
    let mut remaining = expanded_layout["placements"].as_array().unwrap().clone();
    let removed = remaining.iter().position(|p| p["item_id"] == 0).unwrap();
    remaining.remove(removed);
    let subset =
        json!({"used_length_mm":expanded_layout["used_length_mm"], "placements":remaining});
    let subset_input =
        json!({"quantities":[1,1], "initial_placement":subset, "mode":"search", "budget_ms":0});
    let messages = step(&mut recovered, &subset_input.to_string()).unwrap();
    let restored = messages.iter().find(|m| m["type"] == "candidate").unwrap();
    assert_eq!(external(restored)["placements"], subset["placements"]);
    let id = candidate(&messages);
    assert!(Layout::from_snapshot(&recovered.snapshots[&id].layout_snapshot).is_feasible());
}

#[test]
fn invalid_external_layout_is_a_recoverable_warm_error_not_a_cold_start() {
    let mut session = session();
    for placement in [
        json!({"item_id":5,"rotation":0,"translation":[1,1]}),
        json!({"item_id":0,"rotation":45,"translation":[1,1]}),
        json!({"item_id":0,"rotation":0,"translation":[-100,1]}),
        json!({"item_id":-1,"rotation":0,"translation":[1,1]}),
    ] {
        let input = json!({"quantities":[1,0], "initial_placement":{"used_length_mm":30,"placements":[placement]},
            "mode":"search", "budget_ms":0});
        let error = step(&mut session, &input.to_string()).unwrap_err();
        assert!(
            error.starts_with("Invalid initial placement")
                || error.starts_with("Initial placement"),
            "{error}"
        );
    }
}

fn candidate(messages: &[Value]) -> u32 {
    messages
        .iter()
        .find(|value| value["type"] == "candidate")
        .unwrap()["snapshotId"]
        .as_u64()
        .unwrap() as u32
}

#[test]
fn catalog_import_is_shared_across_steps_and_stock_is_preserved() {
    let mut session = session();
    let request = session
        .parse_request(&request(&[1, 0], None, None, "search"))
        .unwrap();
    let (first, solution) = session.prepare(&request, 42).unwrap();
    let (second, _) = session.prepare(&request, 43).unwrap();
    for id in 0..2 {
        assert!(Arc::ptr_eq(
            &session.catalog.items[id].0.shape_cd,
            &first.items[id].0.shape_cd
        ));
        assert!(Arc::ptr_eq(
            &first.items[id].0.shape_orig,
            &second.items[id].0.shape_orig
        ));
    }
    assert!(Arc::ptr_eq(
        first.stock_constraints.as_ref().unwrap(),
        second.stock_constraints.as_ref().unwrap()
    ));
    assert!(Arc::ptr_eq(
        solution.stock_constraints.as_ref().unwrap(),
        session.catalog.stock_constraints.as_ref().unwrap()
    ));
    assert!(solution.time_stamp >= session.epoch);
    assert_eq!(session.catalog.items[0].1, 2);
    assert_eq!(first.items[1].1, 0);
}

#[test]
fn compression_restores_same_parts_without_widening_and_publishes_every_snapshot() {
    let mut session = session();
    let first = candidate(&step(&mut session, &request(&[1, 0], None, None, "search")).unwrap());
    let original = session.snapshots[&first].clone();
    let compression = request(&[1, 0], Some(first), Some(first), "compress")
        .replace("\"budget_ms\":0", "\"budget_ms\":20");
    let messages = step(&mut session, &compression).unwrap();
    assert_eq!(messages.last().unwrap()["type"], "finished");
    for message in messages
        .iter()
        .filter(|message| message["type"] == "candidate")
    {
        let id = message["snapshotId"].as_u64().unwrap() as u32;
        let solution = &session.snapshots[&id];
        assert!(solution.strip.width <= original.strip.width);
        assert_eq!(solution.layout_snapshot.placed_items.len(), 1);
        assert!(Layout::from_snapshot(&solution.layout_snapshot).is_feasible());
    }
    let restored = &session.snapshots[&candidate(&messages)];
    for (key, item) in &original.layout_snapshot.placed_items {
        assert_eq!(
            restored.layout_snapshot.placed_items[key].d_transf,
            item.d_transf
        );
    }
}

#[test]
fn insertion_preserves_internal_keys_and_adds_existing_and_new_ids() {
    let mut session = session();
    let first = candidate(&step(&mut session, &request(&[1, 0], None, None, "search")).unwrap());
    let original = session.snapshots[&first].clone();
    let messages = step(&mut session, &request(&[2, 1], Some(first), None, "search")).unwrap();
    let solution = &session.snapshots[&candidate(&messages)];
    assert_eq!(solution.layout_snapshot.placed_items.len(), 3);
    assert_eq!(
        solution
            .layout_snapshot
            .placed_items
            .values()
            .filter(|item| item.item_id == 0)
            .count(),
        2
    );
    assert_eq!(
        solution
            .layout_snapshot
            .placed_items
            .values()
            .filter(|item| item.item_id == 1)
            .count(),
        1
    );
    for (key, item) in &original.layout_snapshot.placed_items {
        assert_eq!(
            solution.layout_snapshot.placed_items[key].d_transf,
            item.d_transf
        );
    }
    assert!(Layout::from_snapshot(&solution.layout_snapshot).is_feasible());
}

#[test]
fn failed_insertion_and_reduced_demand_keep_retain_restorable() {
    let mut session = session();
    let first = candidate(&step(&mut session, &request(&[1, 0], None, None, "search")).unwrap());
    let error = step(
        &mut session,
        &request(&[500, 0], Some(first), Some(first), "search"),
    )
    .unwrap_err();
    assert!(error.starts_with("Warm start insertion failed:"));
    assert!(session.snapshots.contains_key(&first));
    let error = step(
        &mut session,
        &request(&[0, 1], Some(first), Some(first), "search"),
    )
    .unwrap_err();
    assert!(error.contains("below existing placement"));
    assert!(
        step(
            &mut session,
            &request(&[1, 0], Some(first), Some(first), "search")
        )
        .is_ok()
    );
}

#[test]
fn expired_ids_are_never_recycled_and_unknown_initial_keeps_retain() {
    let mut session = session();
    let old = candidate(&step(&mut session, &request(&[1, 0], None, None, "search")).unwrap());
    let current = candidate(&step(&mut session, &request(&[0, 1], None, None, "search")).unwrap());
    assert!(current > old);
    assert!(!session.snapshots.contains_key(&old));
    assert!(
        step(
            &mut session,
            &request(&[1, 1], Some(old), Some(current), "search")
        )
        .unwrap_err()
        .contains("expired")
    );
    assert!(
        step(
            &mut session,
            &request(&[0, 1], Some(current), None, "search")
        )
        .is_ok()
    );
}

#[test]
fn request_and_constructor_boundaries_are_rejected() {
    let session = session();
    for input in [
        request(&[0, 0], None, None, "search"),
        request(&[1], None, None, "search"),
        request(&[501, 0], None, None, "search"),
        request(&[1, 0], None, None, "other"),
        r#"{"quantities":[1,0],"mode":"search","budget_ms":-1}"#.into(),
        r#"{"quantities":[1,0],"mode":"search","budget_ms":600001}"#.into(),
        r#"{"quantities":[1,0],"mode":"search","budget_ms":1,"extra":true}"#.into(),
    ] {
        assert!(session.parse_request(&input).is_err(), "{input}");
    }
    assert!(SheetSession::create("{}", 0.0, "unknown").is_err());
    assert!(SheetSession::create("{}", f32::NAN, "fast").is_err());
    let large = json!({"quantities":[500,0], "mode":"search", "budget_ms":0,
        "initial_placement":{"used_length_mm":100, "placements":(0..500).map(|_| json!({
            "item_id":0,"rotation":0,"translation":[1,1],"padding":"x".repeat(140)
        })).collect::<Vec<_>>()}})
    .to_string();
    assert!(large.len() > 64 * 1024);
    assert!(session.parse_request(&large).is_ok());
    assert!(session.parse_request(&" ".repeat(1024 * 1024 + 1)).is_err());
}

#[test]
fn continuous_and_automatic_requests_are_accepted() {
    let session = session();
    for mode in ["search", "compress", "continuous"] {
        for budget in [json!(null), json!(0), json!(600_000)] {
            let input = json!({"quantities":[1,0], "mode":mode, "budget_ms":budget});
            let parsed = session.parse_request(&input.to_string()).unwrap();
            assert_eq!(parsed.budget_ms, budget.as_f64());
            assert_eq!(parsed.mode == Mode::Continuous, mode == "continuous");
        }
    }
}

#[test]
fn continuous_phase_deadlines_reset_without_exceeding_global_budget() {
    let session = session();
    let input = request(&[1, 0], None, None, "continuous")
        .replace("\"budget_ms\":0", "\"budget_ms\":10000");
    let request = session.parse_request(&input).unwrap();
    let mut terminator = SessionTerminator::new(&request, None);
    let global = terminator.global_deadline.unwrap();
    terminator.new_timeout(Duration::from_secs(8));
    assert!(terminator.timeout_at().unwrap() < global);
    terminator.phase_deadline = Some(Instant::now() - Duration::from_millis(1));
    assert!(terminator.kill());
    let before_compression = Instant::now();
    terminator.new_timeout(Duration::from_secs(2));
    assert!(!terminator.kill());
    assert!(terminator.timeout_at().unwrap() >= before_compression + Duration::from_secs(2));
    assert!(terminator.timeout_at().unwrap() <= global);
    terminator.new_timeout(Duration::from_secs(20));
    assert_eq!(terminator.timeout_at(), Some(global));
    terminator.global_deadline = Some(Instant::now() - Duration::from_millis(1));
    terminator.new_timeout(Duration::from_secs(2));
    assert!(terminator.kill());
}

#[test]
fn automatic_has_no_deadline_and_legacy_compress_keeps_whole_step_deadline() {
    let session = session();
    for mode in ["compress", "continuous"] {
        let input =
            request(&[1, 0], None, None, mode).replace("\"budget_ms\":0", "\"budget_ms\":null");
        let request = session.parse_request(&input).unwrap();
        let mut terminator = SessionTerminator::new(&request, None);
        for timeout in [Duration::ZERO, Duration::from_secs(600)] {
            terminator.new_timeout(timeout);
            assert_eq!(terminator.timeout_at(), None);
            assert!(!terminator.kill());
        }
    }
    let request = session
        .parse_request(&request(&[1, 0], None, None, "compress"))
        .unwrap();
    let mut terminator = SessionTerminator::new(&request, None);
    let deadline = terminator.timeout_at();
    terminator.new_timeout(Duration::from_secs(60));
    assert_eq!(terminator.timeout_at(), deadline);
    assert!(terminator.kill());
}

#[test]
fn fixed_phase_deadline_cannot_be_reset_and_observes_parent_interrupt() {
    use std::cell::Cell;
    struct Signal(Cell<bool>);
    impl Terminator for Signal {
        fn kill(&self) -> bool {
            self.0.get()
        }
        fn new_timeout(&mut self, _: Duration) {}
        fn timeout_at(&self) -> Option<Instant> {
            None
        }
    }
    let parent = Signal(Cell::new(false));
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut term = PhaseTerminator {
        parent: &parent,
        deadline,
    };
    term.new_timeout(Duration::from_secs(600));
    assert_eq!(term.timeout_at(), Some(deadline));
    assert!(!term.kill());
    parent.0.set(true);
    assert!(term.kill());
    parent.0.set(false);
    term.deadline = Instant::now() - Duration::from_millis(1);
    assert!(term.kill());
}

#[test]
fn finite_compress_restarts_exhausted_runs_without_reexploring() {
    use sparrow::config::ShrinkDecayStrategy;
    let mut session = session();
    session.config.expl_cfg.max_conseq_failed_attempts = Some(1);
    session.config.expl_cfg.separator_config.iter_no_imprv_limit = 1;
    session.config.expl_cfg.separator_config.strike_limit = 1;
    session.config.cmpr_cfg.separator_config.iter_no_imprv_limit = 1;
    session.config.cmpr_cfg.separator_config.strike_limit = 1;
    session.config.cmpr_cfg.shrink_decay = ShrinkDecayStrategy::FailureBased(0.1);
    session.config.cmpr_cfg.shrink_range = (0.1, 0.09);
    let first = candidate(&step(&mut session, &request(&[2, 1], None, None, "search")).unwrap());
    let input = json!({"quantities":[2,1], "initial_snapshot":first,
        "mode":"compress", "budget_ms":1000});
    let request = session.parse_request(&input.to_string()).unwrap();
    let mut term = SessionTerminator::new(&request, None);
    let deadline = term.global_deadline.unwrap();
    let mut messages = vec![];
    session
        .execute(request, 43, &mut term, |message| messages.push(message))
        .unwrap();
    assert!(Instant::now() >= deadline || session.compression.is_some());
    assert_eq!(term.global_deadline, Some(deadline));
    assert_eq!(term.timeout_at(), Some(deadline));
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["report"] == "ExplFeas")
            .count(),
        1
    );
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["type"] == "phase" && m["phase"] == "Compression")
            .count(),
        1
    );
    assert_eq!(messages.last().unwrap()["type"], "finished");
    let mut width = session.snapshots[&first].strip_width();
    for message in messages.iter().filter(|m| m["type"] == "candidate") {
        let solution = &session.snapshots[&(message["snapshotId"].as_u64().unwrap() as u32)];
        assert!(solution.strip_width() <= width);
        width = solution.strip_width();
        assert!(Layout::from_snapshot(&solution.layout_snapshot).is_feasible());
    }
}

#[test]
fn zero_budget_preserves_resident_compression() {
    let mut session = session();
    let first = candidate(&step(&mut session, &request(&[2, 1], None, None, "search")).unwrap());
    install_resident(&mut session, first, &[2, 1]);
    session.compression.as_mut().unwrap().state.failed_attempts = 7;
    let messages = step(
        &mut session,
        &request(&[2, 1], Some(first), None, "compress"),
    )
    .unwrap();
    assert_eq!(
        session.compression.as_ref().unwrap().state.failed_attempts,
        7
    );
    assert_eq!(session.compression.as_ref().unwrap().state.attempts, 0);
    assert_eq!(messages.last().unwrap()["type"], "finished");
}

fn install_resident(session: &mut SheetSession, snapshot: u32, quantities: &[usize]) {
    let parsed = session
        .parse_request(&request(
            quantities,
            Some(snapshot),
            Some(snapshot),
            "compress",
        ))
        .unwrap();
    let (instance, initial) = session.prepare(&parsed, 42).unwrap();
    let signature = layout_signature(&instance, &initial, session.epoch);
    let mut config = session.config.cmpr_cfg;
    config.shrink_decay = sparrow::config::ShrinkDecayStrategy::FailureBased(0.999);
    config.shrink_range = (0.001, 0.000001);
    session.compression = Some(ResidentCompression {
        state: CompressionState::new(
            instance,
            initial,
            Xoshiro256PlusPlus::seed_from_u64(42),
            config,
        ),
        quantities: quantities.to_vec(),
        slice_start: signature,
    });
}

#[test]
fn compression_resumes_across_slices_and_equivalent_snapshot_ids() {
    use std::cell::Cell;
    struct Slice(Cell<usize>);
    impl Terminator for Slice {
        fn kill(&self) -> bool {
            let checks = self.0.get();
            self.0.set(checks + 1);
            checks > 12
        }
        fn new_timeout(&mut self, _: Duration) {}
        fn timeout_at(&self) -> Option<Instant> {
            None
        }
    }
    let mut session = session();
    let first = candidate(&step(&mut session, &request(&[2, 1], None, None, "search")).unwrap());
    install_resident(&mut session, first, &[2, 1]);
    session.compression.as_mut().unwrap().state.failed_attempts = 7;
    let mut initial = first;
    let mut elapsed = Duration::ZERO;
    for _ in 0..3 {
        let parsed = session
            .parse_request(
                &json!({"quantities":[2,1], "initial_snapshot":initial,
            "retain_snapshot":first, "mode":"compress", "budget_ms":10000})
                .to_string(),
            )
            .unwrap();
        let mut messages = vec![];
        session
            .execute(parsed, 999, &mut Slice(Cell::new(0)), |v| messages.push(v))
            .unwrap();
        let resident = session.compression.as_ref().unwrap();
        assert!(resident.state.failed_attempts >= 7);
        assert!(resident.state.active_elapsed > elapsed);
        elapsed = resident.state.active_elapsed;
        assert!(resident.state.attempts > 0);
        initial = candidate(&messages); // a fresh ID for the unchanged slice-start geometry
        assert_ne!(initial, first);
        assert_eq!(
            messages
                .iter()
                .filter(|m| m["report"] == "ExplFeas")
                .count(),
            1
        );
    }
}

#[test]
fn successful_insertion_invalidates_but_failed_search_and_invalid_requests_preserve() {
    let mut session = session();
    let first = candidate(&step(&mut session, &request(&[1, 0], None, None, "search")).unwrap());
    install_resident(&mut session, first, &[1, 0]);
    session.compression.as_mut().unwrap().state.failed_attempts = 9;
    assert!(
        step(
            &mut session,
            &request(&[500, 0], Some(first), Some(first), "search")
        )
        .is_err()
    );
    assert_eq!(
        session.compression.as_ref().unwrap().state.failed_attempts,
        9
    );
    assert!(step(&mut session, "{}").is_err());
    assert_eq!(
        session.compression.as_ref().unwrap().state.failed_attempts,
        9
    );
    step(&mut session, &request(&[2, 1], Some(first), None, "search")).unwrap();
    assert!(session.compression.is_none());
}

#[test]
fn external_deletion_and_same_quantity_branch_invalidate_resident() {
    let mut session = session();
    let messages = step(&mut session, &request(&[2, 1], None, None, "search")).unwrap();
    let first = candidate(&messages);
    let mut layout = external(messages.iter().find(|v| v["type"] == "candidate").unwrap());
    install_resident(&mut session, first, &[2, 1]);
    layout["placements"]
        .as_array_mut()
        .unwrap()
        .retain(|p| p["item_id"] != 1);
    let deleted = step(
        &mut session,
        &json!({"quantities":[2,0], "initial_placement":layout,
        "mode":"search", "budget_ms":0})
        .to_string(),
    )
    .unwrap();
    assert!(session.compression.is_none());
    install_resident(&mut session, candidate(&deleted), &[2, 0]);
    let mut branch = external(deleted.iter().find(|v| v["type"] == "candidate").unwrap());
    // Move both remaining pieces together to make a distinct feasible branch.
    for placement in branch["placements"].as_array_mut().unwrap() {
        let x = placement["translation"][0].as_f64().unwrap();
        placement["translation"][0] = json!(x + 5.0);
    }
    branch["used_length_mm"] = json!(100);
    step(
        &mut session,
        &json!({"quantities":[2,0], "initial_placement":branch,
        "mode":"search", "budget_ms":0})
        .to_string(),
    )
    .unwrap();
    assert!(session.compression.is_none());
}

#[test]
fn continuous_restores_snapshot_and_runs_each_optimizer_phase_once() {
    struct PhaseCounter {
        inner: SessionTerminator,
        budgets: Vec<Duration>,
    }
    impl Terminator for PhaseCounter {
        fn kill(&self) -> bool {
            self.inner.kill()
        }
        fn new_timeout(&mut self, timeout: Duration) {
            self.budgets.push(timeout);
            self.inner.new_timeout(timeout);
        }
        fn timeout_at(&self) -> Option<Instant> {
            self.inner.timeout_at()
        }
    }
    for budget in [json!(0), json!(100), json!(null)] {
        let mut session = session();
        let first =
            candidate(&step(&mut session, &request(&[1, 0], None, None, "search")).unwrap());
        let original = session.snapshots[&first].clone();
        let input = json!({"quantities":[1,0], "mode":"continuous", "budget_ms":budget,
            "initial_snapshot":first, "retain_snapshot":first});
        let request = session.parse_request(&input.to_string()).unwrap();
        let mut terminator = PhaseCounter {
            inner: SessionTerminator::new(&request, None),
            budgets: vec![],
        };
        let mut messages = vec![];
        session
            .execute(request, 42, &mut terminator, |message| {
                messages.push(message)
            })
            .unwrap();
        assert_eq!(terminator.budgets.len(), 2);
        if let Some(budget) = budget.as_f64() {
            assert_eq!(
                terminator.budgets,
                vec![
                    Duration::from_secs_f64(budget / 1000.0 * 0.8),
                    Duration::from_secs_f64(budget / 1000.0 * 0.2),
                ]
            );
        } else {
            assert_eq!(terminator.timeout_at(), None);
        }
        assert_eq!(
            messages
                .iter()
                .filter(|m| m["type"] == "phase" && m["phase"] == "Compression")
                .count(),
            1
        );
        assert_eq!(
            messages
                .iter()
                .filter(|m| m["type"] == "phase" && m["phase"] == "Exploration")
                .count(),
            2
        );
        assert_eq!(messages.last().unwrap()["type"], "finished");
        let restored = &session.snapshots[&candidate(&messages)];
        assert_eq!(restored.strip.width, original.strip.width);
        for message in messages.iter().filter(|m| m["type"] == "candidate") {
            let solution = &session.snapshots[&(message["snapshotId"].as_u64().unwrap() as u32)];
            assert_eq!(solution.layout_snapshot.placed_items.len(), 1);
            assert!(solution.strip.width <= original.strip.width);
            assert!(Layout::from_snapshot(&solution.layout_snapshot).is_feasible());
        }
    }
}
