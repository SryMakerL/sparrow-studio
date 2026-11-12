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

fn candidate(messages: &[Value]) -> u32 {
    messages
        .iter()
        .find(|value| value["type"] == "candidate")
        .unwrap()["snapshotId"]
        .as_u64()
        .unwrap() as u32
}

#[test]
fn coordinate_restoration_preserves_external_transformations_and_inserts_missing_parts() {
    let catalog = json!({"name":"rotated session", "strip_height":100, "stock_length":160,
        "items":[{"id":0,"demand":2,"allowed_orientations":[0,90],
            "shape":{"type":"rectangle","data":{"x_min":7,"y_min":-3,"width":20,"height":10}}},
            {"id":1,"demand":1,"allowed_orientations":[0],
            "shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":12,"height":12}}}]});
    for mode in ["search", "compress", "continuous"] {
        let mut session = SheetSession::create(&catalog.to_string(), 2.0, "fast").unwrap();
        let input = json!({"quantities":[2,1], "mode":mode, "budget_ms":0,
            "initial_placement":{"used_length_mm":70,"placements":[
                {"item_id":0,"rotation":90,"translation":[40,10]}]}});
        let messages = step(&mut session, &input.to_string()).unwrap();
        let solution = &session.snapshots[&candidate(&messages)];
        let output = export(&session.catalog, solution, session.epoch);
        assert_eq!(output.layout.placed_items.len(), 3);
        let restored = output
            .layout
            .placed_items
            .iter()
            .find(|item| {
                let (x, y) = item.transformation.translation;
                item.item_id == 0 && (x - 40.0).abs() < 1e-4 && (y - 10.0).abs() < 1e-4
            })
            .expect("restored external coordinates must survive insertion");
        assert!((restored.transformation.rotation - 90.0).abs() < 1e-4);
        assert!(Layout::from_snapshot(&solution.layout_snapshot).is_feasible());
        assert_eq!(messages.last().unwrap()["type"], "finished");
    }
}

#[test]
fn coordinate_restoration_keeps_catalog_ids_with_zero_demand_entries() {
    let mut session = session();
    let input = json!({"quantities":[0,1],"mode":"search","budget_ms":0,
        "initial_placement":{"used_length_mm":60,"placements":[
            {"item_id":1,"rotation":0,"translation":[40,10]}]}});
    let messages = step(&mut session, &input.to_string()).unwrap();
    let solution = &session.snapshots[&candidate(&messages)];
    let output = export(&session.catalog, solution, session.epoch);
    assert_eq!(output.layout.placed_items.len(), 1);
    let restored = &output.layout.placed_items[0];
    assert_eq!(restored.item_id, 1);
    assert_eq!(restored.transformation.translation, (40.0, 10.0));
    assert!(Layout::from_snapshot(&solution.layout_snapshot).is_feasible());
}

#[test]
fn coordinate_restoration_rejects_invalid_geometry_ids_counts_and_insertions() {
    let valid = json!({"used_length_mm":80,"placements":[
        {"item_id":0,"rotation":0,"translation":[40,10]}]});
    let mut invalid = vec![];
    for (field, value) in [
        ("item_id", json!(99)),
        ("item_id", json!(1)),
        ("rotation", json!(45)),
        ("translation", json!([-100, 10])),
        ("translation", json!([115, 10])),
    ] {
        let mut placement = valid.clone();
        placement["placements"][0][field] = value;
        invalid.push(placement);
    }
    for used in [0, -1, 121] {
        let mut placement = valid.clone();
        placement["used_length_mm"] = json!(used);
        invalid.push(placement);
    }
    invalid.push(json!({"used_length_mm":80,"placements":[]}));
    invalid.push(json!({"used_length_mm":80,"placements":[
        {"item_id":0,"rotation":0,"translation":[40,10]},
        {"item_id":0,"rotation":0,"translation":[40,10]}]}));
    invalid.push(json!({"used_length_mm":120,"placements":[
        {"item_id":0,"rotation":0,"translation":[90,25]}]}));
    invalid.push(json!({"used_length_mm":80,"placements":[
        {"item_id":0,"rotation":0,"translation":[10,10]},
        {"item_id":0,"rotation":0,"translation":[40,10]},
        {"item_id":0,"rotation":0,"translation":[70,10]}]}));
    for initial in invalid {
        let mut session = session();
        let input = json!({"quantities":[2,0],"mode":"search","budget_ms":0,
            "initial_placement":initial});
        let error = step(&mut session, &input.to_string()).unwrap_err();
        assert!(
            error.starts_with("Warm-start restoration failed:"),
            "{error}"
        );
        assert!(session.snapshots.is_empty());
    }
    let mut session = session();
    let input = json!({"quantities":[500,0],"mode":"search","budget_ms":0,
        "initial_placement":valid});
    let error = step(&mut session, &input.to_string()).unwrap_err();
    assert!(error.starts_with("Warm start insertion failed:"));
    assert!(session.snapshots.is_empty());
}

#[test]
fn snapshot_takes_precedence_over_coordinate_restoration() {
    let mut session = session();
    let first = candidate(&step(&mut session, &request(&[1, 0], None, None, "search")).unwrap());
    let original = session.snapshots[&first].clone();
    let input = json!({"quantities":[1,0],"mode":"search","budget_ms":0,
        "initial_snapshot":first, "initial_placement":{"used_length_mm":0,"placements":[]}});
    let messages = step(&mut session, &input.to_string()).unwrap();
    let restored = &session.snapshots[&candidate(&messages)];
    assert_eq!(restored.strip.width, original.strip.width);
    for (key, item) in &original.layout_snapshot.placed_items {
        assert_eq!(
            restored.layout_snapshot.placed_items[key].d_transf,
            item.d_transf
        );
    }
    let mut input = input;
    input["initial_snapshot"] = json!(u32::MAX);
    assert!(
        step(&mut session, &input.to_string())
            .unwrap_err()
            .contains("expired")
    );
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
fn catalog_and_requests_accept_more_than_five_hundred_parts() {
    let items: Vec<_> = (0..501)
        .map(|id| {
            json!({
                "id":id, "demand":if id == 0 { 501 } else { 1 },
                "allowed_orientations":[0],
                "shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":1,"height":1}}
            })
        })
        .collect();
    let input = json!({"name":"large catalog","strip_height":100,"stock_length":100,"items":items});
    let session = SheetSession::create(&input.to_string(), 0.0, "fast").unwrap();
    assert_eq!(session.catalog.items.len(), 501);
    assert_eq!(session.catalog.items[0].1, 501);
    let mut quantities = vec![1; 501];
    quantities[0] = 100_001;
    let parsed = session
        .parse_request(&request(&quantities, None, None, "search"))
        .unwrap();
    assert_eq!(parsed.quantities, quantities);
}

#[test]
fn request_and_constructor_boundaries_are_rejected() {
    let session = session();
    for input in [
        request(&[0, 0], None, None, "search"),
        request(&[1], None, None, "search"),
        r#"{"quantities":[-1,0],"mode":"search","budget_ms":0}"#.into(),
        request(&[1, 0], None, None, "other"),
        r#"{"quantities":[1,0],"mode":"search","budget_ms":-1}"#.into(),
        r#"{"quantities":[1,0],"mode":"search","budget_ms":600001}"#.into(),
        r#"{"quantities":[1,0],"mode":"search","budget_ms":1,"extra":true}"#.into(),
    ] {
        assert!(session.parse_request(&input).is_err(), "{input}");
    }
    assert!(SheetSession::create("{}", 0.0, "unknown").is_err());
    assert!(SheetSession::create("{}", f32::NAN, "fast").is_err());
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
fn finite_compress_restarts_exhausted_phases_until_the_original_deadline() {
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
    assert!(Instant::now() >= deadline);
    assert_eq!(term.global_deadline, Some(deadline));
    assert_eq!(term.timeout_at(), Some(deadline));
    assert!(
        messages
            .iter()
            .filter(|m| m["report"] == "ExplFeas")
            .count()
            > 2
    );
    for phase in ["Exploration", "Compression"] {
        assert_eq!(
            messages.iter()
                .filter(|m| m["type"] == "phase" && m["phase"] == phase)
                .count(),
            1
        );
    }
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
fn geometric_bound_rearranges_single_and_identical_items_until_deadline() {
    use jagua_rs::geometry::DTransformation;
    use jagua_rs::probs::spp::entities::SPPlacement;
    use sparrow::util::listener::SeparationResult;
    use sparrow::util::terminator::BasicTerminator;

    struct Counter {
        reports: Vec<ReportType>,
        phases: Vec<OptimizationPhase>,
        evaluations: usize,
        width: f32,
        quantity: usize,
    }
    impl SolutionListener for Counter {
        fn report_phase(&mut self, phase: OptimizationPhase) { self.phases.push(phase); }
        fn report(&mut self, report: ReportType, solution: &SPSolution, _: &SPInstance) {
            assert_eq!(solution.strip_width(), self.width);
            assert_eq!(solution.layout_snapshot.placed_items.len(), self.quantity);
            assert!(Layout::from_snapshot(&solution.layout_snapshot).is_feasible());
            self.reports.push(report);
        }
        fn report_separation_result(&mut self, result: SeparationResult) {
            self.evaluations += result.total_evals;
        }
    }
<<<<<<< HEAD
    for quantity in [1, 2] {
        let mut session = SheetSession::create(&json!({
            "name":"bound", "strip_height":10, "stock_length":20,
            "items":[
                {"id":0,"demand":1,"allowed_orientations":[0],"shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":9,"height":4}}},
                {"id":1,"demand":2,"allowed_orientations":[0],"shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":4,"height":4}}}
            ]
        }).to_string(), 0.0, "fast").unwrap();
        let input = session.parse_request(&request(&[0, quantity], None, None, "compress")).unwrap();
        let (instance, _) = session.prepare(&input, 42).unwrap();
        let mut problem = SPProblem::new(instance);
        problem.change_strip_width(4.000001);
        let bbox = problem.instance.items[1].0.shape_cd.bbox;
        for i in 0..quantity {
            problem.place_item(SPPlacement { item_id: 1,
                d_transf: DTransformation::new(0.0,
                    (0.0000005 - bbox.x_min, 0.5 + i as f32 * 4.5 - bbox.y_min)) });
        }
        assert!(problem.layout.is_feasible());
        assert!(geometric_lower_bound(&problem) < 4.01);
        let initial = problem.save();
        let mut listener = Counter { reports: vec![], phases: vec![], evaluations: 0,
            width: initial.strip_width(), quantity };
        let started = Instant::now();
        let deadline = started + Duration::from_millis(80);
        compress_until(&problem.instance, initial, 42, &session.config,
            started + Duration::from_millis(40), deadline, &BasicTerminator::new(), &mut listener);
        assert!(Instant::now() >= deadline);
        assert!(listener.evaluations > 0);
        assert_eq!(listener.phases, vec![OptimizationPhase::Exploration, OptimizationPhase::Compression]);
        assert_eq!(listener.reports, vec![ReportType::ExplFeas, ReportType::CmprFeas, ReportType::Final]);
    }
=======
    let mut listener = FinalCounter(0);
    // Exercise the lower-bound exit directly, independently of LBF's placement slack.
    let deadline = started + Duration::from_secs(10);
    let input = session
        .parse_request(
            &request(&[0, 1], None, None, "compress")
                .replace("\"budget_ms\":0", "\"budget_ms\":10000"),
        )
        .unwrap();
    let term = SessionTerminator::new(&input, None);
    compress_until(
        &problem.instance,
        at_bound,
        42,
        &session.config,
        &session.board_cycle_budget,
        deadline,
        deadline,
        &term,
        &mut listener,
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(listener.0, 1);
>>>>>>> dev
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
            1
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
