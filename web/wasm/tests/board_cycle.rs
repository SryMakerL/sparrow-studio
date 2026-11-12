#[path = "../src/stock.rs"]
mod stock;

use jagua_rs::entities::Instance;
use jagua_rs::geometry::DTransformation;
use jagua_rs::io::import::Importer;
use jagua_rs::probs::spp::entities::{SPInstance, SPPlacement, SPProblem, SPSolution};
use jagua_rs::probs::spp::io::{ext_repr::ExtSPInstance, import_instance};
use serde_json::json;
use sparrow::config::DEFAULT_SPARROW_CONFIG;
use sparrow::optimizer::board_cycle::{
    BoardCycleBudget, alternate_boards, alternate_boards_until, alternate_boards_with_budget,
    parse_board_cycle_budget,
};
use sparrow::util::listener::{OptimizationPhase, ReportType, SolutionListener};
use sparrow::util::terminator::{BasicTerminator, Terminator};
use std::{sync::Arc, time::Duration};

fn fixture() -> (SPInstance, SPSolution) {
    let input = json!({
        "name":"alternating boards","strip_height":12,
        "items":[{"id":0,"demand":4,"allowed_orientations":[0],
            "shape":{"type":"rectangle","data":{"x_min":0,"y_min":0,"width":8,"height":8}}}],
        "stock_geometry":{"outer":[[0,0],[61,0],[61,12],[0,12]],"boards":[
            {"outer":[[0,0],[30,0],[30,12],[0,12]]},
            {"outer":[[31,0],[61,0],[61,12],[31,12]]}
        ]}
    });
    let external: ExtSPInstance = serde_json::from_value(input.clone()).unwrap();
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, None, Some(1.0), None);
    let instance = stock::apply(
        import_instance(&importer, &external).unwrap(),
        stock::parse(&input.to_string(), 12.0).unwrap(),
    )
    .unwrap();
    let mut p = SPProblem::new(instance.clone());
    let b = instance.item(0).shape_cd.bbox;
    for x in [5.0, 19.0, 36.0, 50.0] {
        p.place_item(SPPlacement {
            item_id: 0,
            d_transf: DTransformation::new(0.0, (x - b.x_min, 2.0 - b.y_min)),
        });
    }
    assert!(p.layout.is_feasible());
    (instance, p.save())
}
fn sum_lengths(instance: &SPInstance, s: &SPSolution) -> f32 {
    instance
        .stock_constraints
        .as_ref()
        .unwrap()
        .boards
        .iter()
        .map(|board| {
            s.layout_snapshot
                .placed_items
                .values()
                .filter(|p| {
                    p.shape.bbox.x_min >= board.outer.bbox.x_min
                        && p.shape.bbox.x_max <= board.outer.bbox.x_max
                })
                .map(|p| p.shape.bbox.x_max - board.outer.bbox.x_min)
                .fold(0.0, f32::max)
        })
        .sum()
}
#[derive(Default)]
struct Reports {
    candidates: usize,
    local_before_global: bool,
    global_seen: bool,
    first_width: Option<f32>,
    improved_same_outer: bool,
    initial_local: f32,
}
impl SolutionListener for Reports {
    fn report_phase(&mut self, _: OptimizationPhase) {}
    fn report(&mut self, report: ReportType, s: &SPSolution, instance: &SPInstance) {
        if !matches!(
            report,
            ReportType::ExplFeas | ReportType::CmprFeas | ReportType::Final
        ) {
            return;
        }
        let mut p = SPProblem::new(instance.clone());
        p.restore(s);
        assert!(p.layout.is_feasible());
        assert_eq!(p.item_demand_qtys, vec![0]);
        assert_eq!(p.n_placed_items(), 4);
        assert!(Arc::ptr_eq(
            instance.stock_constraints.as_ref().unwrap(),
            s.stock_constraints.as_ref().unwrap()
        ));
        self.candidates += 1;
        if self.first_width != Some(s.strip_width()) {
            self.global_seen = true;
        }
        if self.first_width == Some(s.strip_width())
            && sum_lengths(instance, s) < self.initial_local
        {
            self.improved_same_outer = true;
            if !self.global_seen {
                self.local_before_global = true;
            }
        }
    }
}
#[test]
fn local_work_is_published_before_global_and_never_lost_by_outer_length_ties() {
    let (instance, initial) = fixture();
    let mut cfg = DEFAULT_SPARROW_CONFIG;
    cfg.cmpr_cfg.separator_config.n_workers = 1;
    cfg.expl_cfg.separator_config.n_workers = 1;
    let mut reports = Reports {
        first_width: Some(initial.strip_width()),
        initial_local: sum_lengths(&instance, &initial),
        ..Reports::default()
    };
    let mut term = BasicTerminator::new();
    term.new_timeout(Duration::from_millis(2500));
    let deadline = term.timeout_at().unwrap();
    let result = alternate_boards(&instance, &initial, 42, &cfg, deadline, &term, &mut reports);
    assert!(reports.candidates > 0);
    assert!(reports.local_before_global);
    assert!(reports.improved_same_outer);
    assert!(sum_lengths(&instance, &result) < sum_lengths(&instance, &initial));
    let mut original = SPProblem::new(instance.clone());
    original.restore(&initial);
    assert!(original.layout.is_feasible());
    assert_eq!(original.n_placed_items(), 4);
}
#[test]
fn final_occupied_board_is_not_locally_compacted() {
    use std::cell::Cell;
    use std::rc::Rc;
    struct StopBeforeGlobal(Rc<Cell<bool>>);
    impl Terminator for StopBeforeGlobal {
        fn kill(&self) -> bool {
            self.0.get()
        }
        fn new_timeout(&mut self, _: Duration) {}
        fn timeout_at(&self) -> Option<jagua_rs::Instant> {
            None
        }
    }
    struct LocalReports<'a> {
        initial: &'a SPSolution,
        stop: Rc<Cell<bool>>,
        phases: usize,
        improved: bool,
    }
    impl SolutionListener for LocalReports<'_> {
        fn report_phase(&mut self, _: OptimizationPhase) {
            self.phases += 1;
            // Outer local phase, native exploration, native compression, then global phase.
            if self.phases >= 4 {
                self.stop.set(true);
            }
        }
        fn report(&mut self, report: ReportType, solution: &SPSolution, instance: &SPInstance) {
            if !matches!(
                report,
                ReportType::ExplFeas | ReportType::CmprFeas | ReportType::Final
            ) {
                return;
            }
            for (key, before) in &self.initial.layout_snapshot.placed_items {
                if before.shape.bbox.x_min >= 31.0 {
                    let after = &solution.layout_snapshot.placed_items[key];
                    assert_eq!(
                        after.d_transf, before.d_transf,
                        "tail board must stay fixed in local phase"
                    );
                    assert!(Arc::ptr_eq(&after.shape, &before.shape));
                }
            }
            if sum_lengths(instance, solution) < sum_lengths(instance, self.initial) {
                self.improved = true;
            }
        }
    }
    let (instance, initial) = fixture();
    let mut config = DEFAULT_SPARROW_CONFIG;
    config.expl_cfg.separator_config.n_workers = 1;
    config.cmpr_cfg.separator_config.n_workers = 1;
    let budget = BoardCycleBudget {
        local_ms: 700,
        global_ms: 10,
        evacuation_ms: 10,
        max_rounds: 1,
        ..BoardCycleBudget::default()
    };
    let stop = Rc::new(Cell::new(false));
    let term = StopBeforeGlobal(stop.clone());
    let mut reports = LocalReports {
        initial: &initial,
        stop,
        phases: 0,
        improved: false,
    };
    let result = alternate_boards_with_budget(
        &instance,
        &initial,
        42,
        &config,
        &budget,
        jagua_rs::Instant::now() + Duration::from_secs(2),
        &term,
        &mut reports,
    );
    assert!(
        reports.improved,
        "earlier board must still receive local Sparrow search"
    );
    assert!(
        (3..=4).contains(&reports.phases),
        "one local board emits native phases; global setup may exhaust its short slice"
    );
    for (key, before) in &initial.layout_snapshot.placed_items {
        if before.shape.bbox.x_min >= 31.0 {
            assert_eq!(
                result.layout_snapshot.placed_items[key].d_transf,
                before.d_transf
            );
        }
    }
}

#[test]
fn expired_deadline_returns_original_layout_without_any_local_or_global_reports() {
    let (instance, initial) = fixture();
    let term = BasicTerminator::new();
    let mut reports = Reports::default();
    let result = alternate_boards(
        &instance,
        &initial,
        42,
        &DEFAULT_SPARROW_CONFIG,
        jagua_rs::Instant::now() - Duration::from_millis(1),
        &term,
        &mut reports,
    );
    assert_eq!(result.strip, initial.strip);
    assert_eq!(reports.candidates, 0);
    for (key, item) in &initial.layout_snapshot.placed_items {
        assert_eq!(
            result.layout_snapshot.placed_items[key].d_transf,
            item.d_transf
        );
    }
}

#[test]
fn budget_protocol_defaults_partial_overrides_and_invalid_values() {
    let legacy = parse_board_cycle_budget("{}").unwrap();
    assert_eq!(legacy.local_ms, 10_000);
    assert_eq!(legacy.global_ms, 10_000);
    assert_eq!(legacy.evacuation_ms, 3_000);
    assert_eq!(legacy.stall_rounds, 0);
    assert_eq!(legacy.max_rounds, 0);
    let partial = parse_board_cycle_budget(
        r#"{"board_cycle":{"localMs":900,"maxRounds":0,"stallRounds":0}}"#,
    )
    .unwrap();
    assert_eq!(partial.local_ms, 900);
    assert_eq!(partial.global_ms, 10_000);
    assert_eq!(partial.max_rounds, 0);
    assert_eq!(partial.stall_rounds, 0);
    for value in [
        json!(null),
        json!({"localMs":0}),
        json!({"globalMs":600001}),
        json!({"evacuationMs":1.5}),
        json!({"localPercent":0}),
        json!({"globalPercent":101}),
        json!({"evacuationPercent":-1}),
        json!({"maxRounds":100001}),
        json!({"stallRounds":-1}),
        json!({"unknown":4}),
    ] {
        assert!(parse_board_cycle_budget(&json!({"board_cycle":value}).to_string()).is_err());
    }
}

#[test]
fn automatic_mode_without_combination_deadline_obeys_rounds_and_stop() {
    use std::cell::Cell;
    use std::rc::Rc;
    struct Stop(Rc<Cell<bool>>);
    impl Terminator for Stop {
        fn kill(&self) -> bool {
            self.0.get()
        }
        fn new_timeout(&mut self, _: Duration) {}
        fn timeout_at(&self) -> Option<jagua_rs::Instant> {
            None
        }
    }
    struct StopAfterPhases {
        flag: Rc<Cell<bool>>,
        count: usize,
    }
    impl SolutionListener for StopAfterPhases {
        fn report(&mut self, _: ReportType, _: &SPSolution, _: &SPInstance) {}
        fn report_phase(&mut self, _: OptimizationPhase) {
            self.count += 1;
            if self.count >= 12 {
                self.flag.set(true);
            }
        }
    }
    let (instance, initial) = fixture();
    let mut config = DEFAULT_SPARROW_CONFIG;
    config.cmpr_cfg.separator_config.n_workers = 1;
    config.expl_cfg.separator_config.n_workers = 1;
    let mut budget = BoardCycleBudget {
        local_ms: 5,
        global_ms: 5,
        evacuation_ms: 5,
        max_rounds: 1,
        stall_rounds: 0,
        ..BoardCycleBudget::default()
    };
    let stop = Rc::new(Cell::new(false));
    let term = Stop(stop.clone());
    let mut one = PhaseCount(0);
    let result = alternate_boards_until(
        &instance, &initial, 42, &config, &budget, None, &term, &mut one,
    );
    assert!(one.0 > 0);
    assert!(!term.kill());
    let mut p = SPProblem::new(instance.clone());
    p.restore(&result);
    assert!(p.layout.is_feasible());
    budget.max_rounds = 0;
    let mut many = StopAfterPhases {
        flag: stop,
        count: 0,
    };
    let result = alternate_boards_until(
        &instance, &initial, 42, &config, &budget, None, &term, &mut many,
    );
    assert!(many.count >= 12);
    assert!(term.kill());
    let mut p = SPProblem::new(instance);
    p.restore(&result);
    assert!(p.layout.is_feasible());
    assert_eq!(p.item_demand_qtys, vec![0]);
}

struct PhaseCount(usize);
impl SolutionListener for PhaseCount {
    fn report(&mut self, _: ReportType, _: &SPSolution, _: &SPInstance) {}
    fn report_phase(&mut self, _: OptimizationPhase) {
        self.0 += 1;
    }
}

#[test]
fn configurable_round_cap_and_zero_limits_control_actual_loop() {
    let (instance, initial) = fixture();
    let mut cfg = DEFAULT_SPARROW_CONFIG;
    cfg.cmpr_cfg.separator_config.n_workers = 1;
    cfg.expl_cfg.separator_config.n_workers = 1;
    let mut budget = BoardCycleBudget {
        local_ms: 5,
        global_ms: 5,
        evacuation_ms: 5,
        max_rounds: 1,
        stall_rounds: 0,
        ..BoardCycleBudget::default()
    };
    let mut term = BasicTerminator::new();
    term.new_timeout(Duration::from_secs(1));
    let mut reports = PhaseCount(0);
    alternate_boards_with_budget(
        &instance,
        &initial,
        42,
        &cfg,
        &budget,
        term.timeout_at().unwrap(),
        &term,
        &mut reports,
    );
    let first_round_phases = reports.0;
    assert!(
        first_round_phases <= 6,
        "one round includes local Sparrow phases for two boards"
    );
    budget.max_rounds = 0;
    budget.stall_rounds = 0;
    term.new_timeout(Duration::from_millis(250));
    let deadline = term.timeout_at().unwrap();
    let mut reports = PhaseCount(0);
    let result = alternate_boards_with_budget(
        &instance,
        &initial,
        42,
        &cfg,
        &budget,
        deadline,
        &term,
        &mut reports,
    );
    assert!(
        reports.0 > first_round_phases,
        "disabled round caps must permit more than one cycle"
    );
    assert!(jagua_rs::Instant::now() >= deadline);
    let mut p = SPProblem::new(instance);
    p.restore(&result);
    assert!(p.layout.is_feasible());
    assert_eq!(p.item_demand_qtys, vec![0]);
}
