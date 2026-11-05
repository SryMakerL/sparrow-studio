use crate::{solver_config, stock, thread_count, warm_start};
use jagua_rs::Instant;
use jagua_rs::io::import::Importer;
use jagua_rs::probs::spp::entities::{SPInstance, SPProblem, SPSolution};
use jagua_rs::probs::spp::io::{export, ext_repr::ExtSPInstance, import_instance};
use rand::{SeedableRng, rngs::Xoshiro256PlusPlus};
use serde::Deserialize;
use serde_json::{Value, json};
use sparrow::config::SparrowConfig;
use sparrow::consts::LBF_SAMPLE_CONFIG;
use sparrow::optimizer::{
    compress::{CompressionOutcome, CompressionState},
    lbf::LBFBuilder,
    optimize,
};
use sparrow::util::listener::{OptimizationPhase, ReportType, SolutionListener};
use sparrow::util::terminator::Terminator;
use std::{collections::BTreeMap, time::Duration};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    quantities: Vec<usize>,
    initial_snapshot: Option<u32>,
    initial_placement: Option<Value>,
    retain_snapshot: Option<u32>,
    mode: Mode,
    budget_ms: Option<f64>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Search,
    Compress,
    Continuous,
}

#[wasm_bindgen]
pub struct SheetSession {
    catalog: SPInstance,
    config: SparrowConfig,
    epoch: Instant,
    snapshots: BTreeMap<u32, SPSolution>,
    next_snapshot: u32,
    compression: Option<ResidentCompression>,
}

struct ResidentCompression {
    state: CompressionState,
    quantities: Vec<usize>,
    slice_start: Value,
}

fn layout_signature(instance: &SPInstance, solution: &SPSolution, epoch: Instant) -> Value {
    let exported = serde_json::to_value(export(instance, solution, epoch)).unwrap();
    let mut placements = exported["layout"]["placed_items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| json!([item["item_id"], item["transformation"]]).to_string())
        .collect::<Vec<_>>();
    placements.sort();
    json!([exported["strip_width"], placements])
}

impl ResidentCompression {
    fn compatible(
        &self,
        quantities: &[usize],
        initial: &Value,
        instance: &SPInstance,
        epoch: Instant,
    ) -> bool {
        self.quantities == quantities
            && (*initial == self.slice_start
                || *initial == layout_signature(instance, self.state.best(), epoch))
    }
}

#[wasm_bindgen]
impl SheetSession {
    #[wasm_bindgen(constructor)]
    pub fn new(input: &str, clearance: f32, preset: &str) -> Result<SheetSession, JsValue> {
        console_error_panic_hook::set_once();
        crate::logging::init();
        Self::create(input, clearance, preset).map_err(|error| JsValue::from_str(&error))
    }

    pub fn step(
        &mut self,
        request: &str,
        seed: &str,
        callback: js_sys::Function,
        interrupt: Option<js_sys::Function>,
    ) -> Result<(), JsValue> {
        let request = self
            .parse_request(request)
            .map_err(|error| JsValue::from_str(&error))?;
        let seed = seed
            .parse::<u64>()
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let mut terminator = SessionTerminator::new(&request, interrupt);
        let mut callback_error = None;
        let result = self.execute(request, seed, &mut terminator, |value| {
            if callback_error.is_none() {
                if let Err(error) =
                    callback.call1(&JsValue::NULL, &JsValue::from_str(&value.to_string()))
                {
                    callback_error = Some(error);
                }
            }
        });
        if let Some(error) = callback_error {
            return Err(error);
        }
        result.map_err(|error| JsValue::from_str(&error))
    }
}

impl SheetSession {
    fn create(input: &str, clearance: f32, preset: &str) -> Result<Self, String> {
        let epoch = Instant::now();
        if input.len() > 10 * 1024 * 1024 || !clearance.is_finite() || clearance < 0.0 {
            return Err("Invalid clearance or oversized input".into());
        }
        let mut config = solver_config(preset, thread_count(), None)?;
        config.min_item_separation = (clearance > 0.0).then_some(clearance);
        let external: ExtSPInstance =
            serde_json::from_str(input).map_err(|error| error.to_string())?;
        if !external.strip_height.is_finite()
            || external.strip_height <= clearance
            || external.strip_height > 100_000.0
            || external.items.is_empty()
            || external.items.len() > 500
            || external
                .items
                .iter()
                .any(|item| item.demand == 0 || item.demand > 500)
            || external.items.iter().map(|item| item.demand).sum::<u64>() > 500
        {
            return Err("Invalid strip dimensions or catalog demand".into());
        }
        let constraints = stock::parse(input, external.strip_height)?;
        let finite_stock = warm_start::parse(input)?;
        let importer = Importer::new(
            config.cde_config,
            config.poly_simpl_tolerance,
            config.min_item_separation,
            config.narrow_concavity_cutoff_ratio,
        );
        let catalog = import_instance(&importer, &external).map_err(|error| error.to_string())?;
        let catalog = stock::apply(catalog, constraints)?;
        let catalog = warm_start::apply_stock_length(catalog, &finite_stock)?;
        if catalog.stock_constraints.is_none() {
            return Err("SheetSession requires finite stock_length or stock_geometry".into());
        }
        Ok(Self {
            catalog,
            config,
            epoch,
            snapshots: BTreeMap::new(),
            next_snapshot: 1,
            compression: None,
        })
    }

    fn parse_request(&self, input: &str) -> Result<Request, String> {
        if input.len() > 1024 * 1024 {
            return Err("Oversized session request".into());
        }
        let request: Request = serde_json::from_str(input).map_err(|error| error.to_string())?;
        if request.quantities.len() != self.catalog.items.len()
            || request.quantities.iter().any(|&qty| qty > 500)
            || !(1..=500).contains(&request.quantities.iter().sum::<usize>())
            || request
                .budget_ms
                .is_some_and(|budget| !budget.is_finite() || !(0.0..=600_000.0).contains(&budget))
        {
            return Err("Invalid session quantities or budget_ms (expected 0..600000)".into());
        }
        Ok(request)
    }

    fn prepare(
        &mut self,
        request: &Request,
        seed: u64,
    ) -> Result<(SPInstance, SPSolution), String> {
        self.snapshots.retain(|id, _| {
            Some(*id) == request.initial_snapshot || Some(*id) == request.retain_snapshot
        });
        for id in [request.initial_snapshot, request.retain_snapshot]
            .into_iter()
            .flatten()
        {
            if !self.snapshots.contains_key(&id) {
                return Err(format!("Unknown or expired snapshot: {id}"));
            }
        }
        let mut instance = self.catalog.clone();
        for ((_, qty), requested) in instance.items.iter_mut().zip(&request.quantities) {
            *qty = *requested;
        }
        let rng = Xoshiro256PlusPlus::seed_from_u64(seed);
        let builder = if let Some(id) = request.initial_snapshot {
            let initial = &self.snapshots[&id];
            let mut placed = vec![0; instance.items.len()];
            for item in initial.layout_snapshot.placed_items.values() {
                placed[item.item_id] += 1;
            }
            if placed
                .iter()
                .zip(&request.quantities)
                .any(|(old, new)| old > new)
            {
                return Err("Warm start insertion failed: requested quantity is below existing placement count".into());
            }
            let mut problem = SPProblem::new(instance.clone());
            problem.restore(initial);
            if problem.item_demand_qtys.iter().all(|&qty| qty == 0) {
                return Ok((instance, initial.clone()));
            }
            problem.change_strip_width(instance.stock_constraints.as_ref().unwrap().max_width);
            LBFBuilder::from_problem(problem, rng, LBF_SAMPLE_CONFIG)
        } else if let Some(external) = &request.initial_placement {
            let input = warm_start::parse(&json!({"initial_placement": external}).to_string())
                .map_err(|error| format!("Invalid initial placement: {error}"))?;
            let solution = warm_start::construct(&instance, &input, rng)?
                .ok_or_else(|| "Invalid initial placement: missing layout".to_string())?;
            return Ok((instance, solution));
        } else {
            LBFBuilder::new(instance.clone(), rng, LBF_SAMPLE_CONFIG)
        };
        let solution = builder
            .construct()
            .map_err(|error| format!("Warm start insertion failed: {error}"))?
            .prob
            .save();
        Ok((instance, solution))
    }

    fn execute(
        &mut self,
        request: Request,
        seed: u64,
        terminator: &mut impl Terminator,
        send: impl FnMut(Value),
    ) -> Result<(), String> {
        let started = Instant::now();
        let (instance, initial) = self.prepare(&request, seed)?;
        let signature = layout_signature(&instance, &initial, self.epoch);
        let compatible = self.compression.as_ref().is_some_and(|resident| {
            resident.compatible(&request.quantities, &signature, &instance, self.epoch)
        });
        if !compatible || request.mode == Mode::Continuous {
            self.compression = None;
        }
        let mut listener = SessionListener {
            snapshots: &mut self.snapshots,
            next_snapshot: &mut self.next_snapshot,
            epoch: self.epoch,
            started,
            sequence: 0,
            last_live: None,
            config: &self.config,
            send,
        };
        listener.report_phase(OptimizationPhase::Exploration);
        listener.report(ReportType::ExplFeas, &initial, &instance);
        if request.mode == Mode::Compress && request.budget_ms.is_some() {
            let budget = Duration::from_secs_f64(request.budget_ms.unwrap() / 1000.0);
            let deadline = terminator
                .timeout_at()
                .unwrap_or(started + budget)
                .min(started + budget);
            listener.report_phase(OptimizationPhase::Compression);
            let term = PhaseTerminator {
                parent: terminator,
                deadline,
            };
            if !term.kill() {
                let resident = self.compression.get_or_insert_with(|| ResidentCompression {
                    state: CompressionState::new(
                        instance.clone(),
                        initial,
                        Xoshiro256PlusPlus::seed_from_u64(seed),
                        self.config.cmpr_cfg,
                    ),
                    quantities: request.quantities.clone(),
                    slice_start: signature.clone(),
                });
                resident.slice_start = signature;
                let mut restarted_without_progress = false;
                loop {
                    let attempts = resident.state.attempts;
                    match resident.state.advance(&term, &mut listener) {
                        CompressionOutcome::Paused | CompressionOutcome::BoundReached => break,
                        CompressionOutcome::Exhausted => {
                            let no_progress = resident.state.attempts == attempts;
                            if term.kill() || (no_progress && restarted_without_progress) {
                                break;
                            }
                            restarted_without_progress = no_progress;
                            resident.state.restart_cycle();
                        }
                    }
                }
                listener.report(ReportType::Final, resident.state.best(), &instance);
            }
        } else if request.mode != Mode::Search {
            let mut exploration = self.config.expl_cfg;
            let mut compression = self.config.cmpr_cfg;
            if let Some(budget_ms) = request.budget_ms {
                exploration.time_limit = Duration::from_secs_f64(budget_ms / 1000.0 * 0.8);
                compression.time_limit = Duration::from_secs_f64(budget_ms / 1000.0 * 0.2);
            }
            optimize(
                instance,
                Xoshiro256PlusPlus::seed_from_u64(seed),
                &mut listener,
                terminator,
                &exploration,
                &compression,
                Some(&initial),
            )
            .map_err(|error| format!("Warm start insertion failed: {error}"))?;
        }
        (listener.send)(json!({"type":"finished"}));
        Ok(())
    }
}

// Phase deadlines are absolute: restarting a naturally exhausted optimizer must not
// grant it another phase budget, or let it consume the next phase's allocation.
struct PhaseTerminator<'a, T> {
    parent: &'a T,
    deadline: Instant,
}

impl<T: Terminator> Terminator for PhaseTerminator<'_, T> {
    fn kill(&self) -> bool {
        Instant::now() >= self.deadline || self.parent.kill()
    }

    fn new_timeout(&mut self, _: Duration) {}

    fn timeout_at(&self) -> Option<Instant> {
        Some(self.deadline)
    }
}

struct SessionListener<'a, F> {
    snapshots: &'a mut BTreeMap<u32, SPSolution>,
    next_snapshot: &'a mut u32,
    epoch: Instant,
    started: Instant,
    sequence: u32,
    last_live: Option<Instant>,
    config: &'a SparrowConfig,
    send: F,
}

impl<F: FnMut(Value)> SolutionListener for SessionListener<'_, F> {
    fn report_phase(&mut self, phase: OptimizationPhase) {
        (self.send)(json!({"type":"phase", "phase":format!("{phase:?}"),
            "workers":match phase { OptimizationPhase::Exploration => self.config.expl_cfg.separator_config.n_workers,
                OptimizationPhase::Compression => self.config.cmpr_cfg.separator_config.n_workers },
            "initializationMs":self.started.elapsed().as_secs_f64() * 1000.0}));
    }

    fn report(&mut self, report: ReportType, solution: &SPSolution, instance: &SPInstance) {
        let feasible = matches!(
            report,
            ReportType::ExplFeas | ReportType::CmprFeas | ReportType::Final
        );
        if !feasible
            && self
                .last_live
                .is_some_and(|last| last.elapsed() < Duration::from_millis(100))
        {
            return;
        }
        self.last_live = Some(Instant::now());
        self.sequence += 1;
        let mut value = json!({"type":if feasible {"candidate"} else {"live"},
            "sequence":self.sequence, "report":format!("{report:?}"),
            "elapsedMs":self.started.elapsed().as_secs_f64() * 1000.0,
            "solution":export(instance, solution, self.epoch)});
        if feasible {
            // Never recycle a published ID or evict a candidate during its step.
            let id = *self.next_snapshot;
            *self.next_snapshot = id
                .checked_add(1)
                .expect("session snapshot ID space exhausted");
            self.snapshots.insert(id, solution.clone());
            value["snapshotId"] = json!(id);
        }
        (self.send)(value);
    }
}

struct SessionTerminator {
    global_deadline: Option<Instant>,
    phase_deadline: Option<Instant>,
    continuous: bool,
    interrupt: Option<js_sys::Function>,
}

impl SessionTerminator {
    fn new(request: &Request, interrupt: Option<js_sys::Function>) -> Self {
        let global_deadline = request
            .budget_ms
            .map(|budget| Instant::now() + Duration::from_secs_f64(budget / 1000.0));
        Self {
            global_deadline,
            phase_deadline: global_deadline,
            continuous: request.mode == Mode::Continuous,
            interrupt,
        }
    }
}

impl Terminator for SessionTerminator {
    fn kill(&self) -> bool {
        self.timeout_at()
            .is_some_and(|deadline| Instant::now() >= deadline)
            || self.interrupt.as_ref().is_some_and(|signal| {
                signal
                    .call1(&JsValue::NULL, &JsValue::FALSE)
                    .ok()
                    .and_then(|value| value.as_bool())
                    .unwrap_or(true)
            })
    }
    fn new_timeout(&mut self, timeout: Duration) {
        if self.continuous {
            self.phase_deadline = self
                .global_deadline
                .map(|global| (Instant::now() + timeout).min(global));
        }
    }
    fn timeout_at(&self) -> Option<Instant> {
        self.phase_deadline
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
