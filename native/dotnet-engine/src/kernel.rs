use super::*;
use jagua_rs::probs::spp::entities::SPProblem;
use sparrow::consts::LBF_SAMPLE_CONFIG;
use sparrow::optimizer::lbf::LBFBuilder;
use sparrow::util::listener::OptimizationPhase;
use std::collections::BTreeMap;

pub(crate) struct Kernel {
    job: Job,
    catalog: SPInstance,
    config: SparrowConfig,
    snapshots: BTreeMap<u32, SPSolution>,
    next: u32,
}

impl Kernel {
    pub(crate) fn new(job: Job) -> Result<Self, String> {
        if job.settings.auto_add_sheets
            || job.settings.sheet_count.is_some()
            || job.settings.sheet_stocks.is_some()
        {
            return Err(
                "Sheet kernel requires a single-stock catalog, not an aggregate job".into(),
            );
        }
        let items: Vec<_> = job.parts.iter().enumerate().map(|(id,p)| json!({"id":id,"demand":1,"priority":p.priority,"allowed_orientations":match &p.rotations { Rotations::Continuous=>None,Rotations::Discrete{degrees}=>Some(degrees.iter().map(|d|d.rem_euclid(360.0)).collect::<Vec<_>>()) },"shape":{"type":"simple_polygon","data":p.outer}})).collect();
        let mut external = json!({"name":job.name,"strip_height":job.settings.material_width_mm,"items":items,"stock_length":job.settings.sheet_length_mm});
        if let Some(SheetStock {
            shape: StockShape::Polygon { outer, holes, .. },
            ..
        }) = &job.settings.sheet_stock
        {
            external["stock_geometry"] = json!({"outer":outer,"holes":holes});
        }
        let text = external.to_string();
        let ext: ExtSPInstance = serde_json::from_value(external).map_err(|e| e.to_string())?;
        let mut config =
            solver_config(&job.settings.solver_preset, job.settings.time_limit_seconds);
        config.min_item_separation =
            (job.settings.clearance_mm > 0.0).then_some(job.settings.clearance_mm as f32);
        let importer = Importer::new(
            config.cde_config,
            config.poly_simpl_tolerance,
            config.min_item_separation,
            config.narrow_concavity_cutoff_ratio,
        );
        let catalog = import_instance(&importer, &ext).map_err(|e| e.to_string())?;
        let catalog = stock::apply(catalog, stock::parse(&text, ext.strip_height)?)?;
        let catalog = warm_start::apply_stock_length(catalog, &warm_start::parse(&text)?)?;
        Ok(Self {
            job,
            catalog,
            config,
            snapshots: BTreeMap::new(),
            next: 1,
        })
    }

    pub(crate) fn step(
        &mut self,
        request: &Value,
        seed: u64,
        revision: u32,
        cancel: Option<&Cancel>,
        send: &mut dyn FnMut(Value),
    ) -> Result<Value, String> {
        let quantities: Vec<usize> =
            serde_json::from_value(request["quantities"].clone()).map_err(|e| e.to_string())?;
        let mode = request["mode"].as_str().unwrap_or("search");
        let budget = request
            .get("budget_ms")
            .or_else(|| request.get("budgetMs"))
            .filter(|v| !v.is_null())
            .map(|v| v.as_f64().ok_or("Invalid budget_ms"))
            .transpose()?;
        if quantities.len() != self.job.parts.len()
            || !quantities.iter().any(|n| *n > 0)
            || !["search", "compress", "continuous"].contains(&mode)
            || budget.is_some_and(|b| !b.is_finite() || !(0.0..=600000.0).contains(&b))
        {
            return Err("Invalid session quantities, mode or budget_ms".into());
        }
        let snapshot = |key: &str| -> Result<Option<u32>, String> {
            request
                .get(key)
                .filter(|v| !v.is_null())
                .map(|v| {
                    v.as_u64()
                        .and_then(|n| u32::try_from(n).ok())
                        .ok_or_else(|| format!("Invalid {key}"))
                })
                .transpose()
        };
        let initial_id = snapshot("initial_snapshot")?;
        let retain = snapshot("retain_snapshot")?;
        for id in [initial_id, retain].into_iter().flatten() {
            if !self.snapshots.contains_key(&id) {
                return Err(format!("Unknown or expired snapshot: {id}"));
            }
        }
        self.snapshots
            .retain(|id, _| Some(*id) == initial_id || Some(*id) == retain);
        let started = Instant::now();
        let mut term = StepTerminator {
            cancel,
            deadline: budget.map(|b| started + Duration::from_secs_f64(b / 1000.0)),
            phase: None,
        };
        if term.kill() {
            return Err("cancelled".into());
        }
        let mut instance = self.catalog.clone();
        let mut child = self.job.clone();
        child.settings.sheet_count = None;
        child.settings.sheet_stocks = None;
        for ((item, part), n) in instance
            .items
            .iter_mut()
            .zip(&mut child.parts)
            .zip(&quantities)
        {
            item.1 = *n;
            part.quantity = *n;
        }
        let rng = Xoshiro256PlusPlus::seed_from_u64(seed);
        let initial = if let Some(id) = initial_id {
            let old = &self.snapshots[&id];
            let mut counts = vec![0; quantities.len()];
            for p in old.layout_snapshot.placed_items.values() {
                counts[p.item_id] += 1;
            }
            if counts.iter().zip(&quantities).any(|(a, b)| a > b) {
                return Err("Warm start insertion failed: requested quantity is below existing placement count".into());
            }
            let mut problem = SPProblem::new(instance.clone());
            problem.restore(old);
            if problem.item_demand_qtys.iter().all(|n| *n == 0) {
                old.clone()
            } else {
                if let Some(stock) = &instance.stock_constraints {
                    problem.change_strip_width(stock.max_width);
                }
                LBFBuilder::from_problem(problem, rng, LBF_SAMPLE_CONFIG)
                    .construct()
                    .map_err(|e| format!("Warm start insertion failed: {e}"))?
                    .prob
                    .save()
            }
        } else if let Some(placement) = request.get("initial_placement").filter(|v| !v.is_null()) {
            let warm = warm_start::parse(&json!({"initial_placement":placement}).to_string())?;
            warm_start::construct(&instance, &warm, rng)?.ok_or("Missing warm start")?
        } else {
            LBFBuilder::new(instance.clone(), rng, LBF_SAMPLE_CONFIG)
                .construct()
                .map_err(|e| {
                    format!(
                        "No valid initial placement could be constructed for item {}",
                        e.item_id
                    )
                })?
                .prob
                .save()
        };
        let mut listener = NativeListener {
            job: &child,
            seed,
            revision,
            started,
            best: None,
            snapshots: &mut self.snapshots,
            next: &mut self.next,
            send,
        };
        listener.report_phase(OptimizationPhase::Exploration);
        listener.report(ReportType::ExplFeas, &initial, &instance);
        if let Some(compression_budget) = budget.filter(|_| mode == "compress" && !term.kill()) {
            let duration = Duration::from_secs_f64(compression_budget / 1000.0);
            let deadline = started + duration;
            compression::run(
                &instance,
                initial,
                seed,
                &self.config,
                deadline - duration.mul_f64(0.2),
                deadline,
                &term,
                &mut listener,
            );
        } else if mode != "search" && !term.kill() {
            let mut expl = self.config.expl_cfg;
            let mut cmpr = self.config.cmpr_cfg;
            if let Some(b) = budget {
                expl.time_limit = Duration::from_secs_f64(b / 1000.0 * 0.8);
                cmpr.time_limit = Duration::from_secs_f64(b / 1000.0 * 0.2);
            }
            optimize(
                instance.clone(),
                Xoshiro256PlusPlus::seed_from_u64(seed),
                &mut listener,
                &mut term,
                &expl,
                &cmpr,
                Some(&initial),
            )
            .map_err(|e| e.to_string())?;
        }
        let mut best = listener.best.ok_or("No independently valid candidate")?;
        best["cancelled"] = json!(term.cancelled());
        (listener.send)(json!({"type":"finished","cancelled":term.cancelled(),"result":best}));
        Ok(best)
    }
}

struct NativeListener<'a> {
    job: &'a Job,
    seed: u64,
    revision: u32,
    started: Instant,
    best: Option<Value>,
    snapshots: &'a mut BTreeMap<u32, SPSolution>,
    next: &'a mut u32,
    send: &'a mut dyn FnMut(Value),
}
impl SolutionListener for NativeListener<'_> {
    fn report_phase(&mut self, phase: OptimizationPhase) {
        (self.send)(json!({"type":"phase","phase":format!("{phase:?}"),"workers":1}));
    }
    fn report(&mut self, report: ReportType, solution: &SPSolution, instance: &SPInstance) {
        if !matches!(
            report,
            ReportType::ExplFeas | ReportType::CmprFeas | ReportType::Final
        ) {
            return;
        }
        let out = export(instance, solution, self.started);
        let mut counts = vec![0usize; self.job.parts.len()];
        let placements:Vec<_>=out.layout.placed_items.into_iter().map(|p|{let i=p.item_id as usize;let t=serde_json::to_value(p.transformation).unwrap();let n=counts[i];counts[i]+=1;json!({"partId":self.job.parts[i].id,"copyIndex":n,"xMm":t["translation"][0],"yMm":t["translation"][1],"angleDeg":t["rotation"]})}).collect();
        let mut value = json!({"documentRevision":self.revision,"solverRevision":SOLVER_REVISION,"seed":self.seed.to_string(),"elapsedSeconds":self.started.elapsed().as_secs_f64(),"usedLengthMm":out.strip_width,"placements":placements});
        value["validation"] = validation::check(self.job, &value);
        if value["validation"]["status"] != "passed" {
            return;
        }
        let id = *self.next;
        let Some(next) = id.checked_add(1) else {
            return;
        };
        *self.next = next;
        self.snapshots.insert(id, solution.clone());
        value["snapshotId"] = json!(id);
        if self
            .best
            .as_ref()
            .is_none_or(|best| value["usedLengthMm"].as_f64() <= best["usedLengthMm"].as_f64())
        {
            self.best = Some(value.clone());
        }
        (self.send)(
            json!({"type":"candidate","snapshotId":id,"report":format!("{report:?}"),"result":value}),
        );
    }
}

struct StepTerminator<'a> {
    cancel: Option<&'a Cancel>,
    deadline: Option<Instant>,
    phase: Option<Instant>,
}
impl StepTerminator<'_> {
    fn cancelled(&self) -> bool {
        self.cancel
            .is_some_and(|c| c.requested.load(Ordering::Relaxed))
    }
}
impl Terminator for StepTerminator<'_> {
    fn kill(&self) -> bool {
        self.cancelled() || self.timeout_at().is_some_and(|d| Instant::now() >= d)
    }
    fn new_timeout(&mut self, d: Duration) {
        self.phase = self.deadline.map(|g| (Instant::now() + d).min(g));
    }
    fn timeout_at(&self) -> Option<Instant> {
        self.phase.or(self.deadline)
    }
}
