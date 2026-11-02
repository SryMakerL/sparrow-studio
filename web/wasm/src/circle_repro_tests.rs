use super::*;

#[test]
fn circle_browser_seed_2549684069586028516_gap2_three_workers() {
    let seed = 2_549_684_069_586_028_516;
    let mut config = solver_config("standard", 3, Some(10)).unwrap();
    config.min_item_separation = Some(2.0);
    assert_eq!(config.expl_cfg.time_limit, Duration::from_secs(8));
    assert_eq!(config.cmpr_cfg.time_limit, Duration::from_secs(2));
    assert_eq!(config.expl_cfg.separator_config.n_workers, 3);
    assert_eq!(config.cmpr_cfg.separator_config.n_workers, 3);
    let external: ExtSPInstance = serde_json::from_str(INPUT).unwrap();
    let constraints = stock::parse(INPUT, external.strip_height).unwrap();
    let importer = Importer::new(config.cde_config, config.poly_simpl_tolerance,
        config.min_item_separation, config.narrow_concavity_cutoff_ratio);
    let instance = stock::apply(import_instance(&importer, &external).unwrap(), constraints).unwrap();
    let mut listener = Listener::default();
    let start = Instant::now();
    let solution = optimize(instance.clone(), Xoshiro256PlusPlus::seed_from_u64(seed),
        &mut listener, &mut BasicTerminator::new(), &config.expl_cfg, &config.cmpr_cfg,
        None).unwrap();
    assert_eq!(listener.phases, [OptimizationPhase::Exploration, OptimizationPhase::Compression]);
    assert_eq!(listener.finals, 1);
    assert!(listener.separations > 0);
    let mut restored = jagua_rs::probs::spp::entities::SPProblem::new(instance);
    restored.restore(&solution);
    assert!(restored.layout.is_feasible());
    eprintln!("circle browser seed={seed} gap=2 workers=3 passed width={} separations={} elapsed={:?}",
        solution.strip.width, listener.separations, start.elapsed());
}

const INPUT: &str = include_str!("../../../test/circle-repro-input.json");

#[derive(Default)]
struct Listener {
    phases: Vec<OptimizationPhase>,
    separations: usize,
    finals: usize,
}

impl SolutionListener for Listener {
    fn report_phase(&mut self, phase: OptimizationPhase) {
        self.phases.push(phase);
    }

    fn report_separation_progress(&mut self, progress: sparrow::util::listener::SeparationProgress) {
        if progress.iteration == 0 {
            eprintln!("circle separation width={} loss={}", progress.strip_width, progress.min_loss);
        }
    }

    fn report_separation_result(&mut self, _: sparrow::util::listener::SeparationResult) {
        self.separations += 1;
    }

    fn report(&mut self, report: ReportType, solution: &SPSolution, _: &SPInstance) {
        if matches!(report, ReportType::Final) {
            self.finals += 1;
            assert_eq!(solution.layout_snapshot.placed_items.len(), 30);
        }
    }
}

#[test]
fn circle_fixture_native_regression() {
    let value: serde_json::Value = serde_json::from_str(INPUT).unwrap();
    assert_eq!(value["stock_geometry"]["outer"].as_array().unwrap().len(), 1056);
    assert_eq!(value["stock_geometry"]["holes"][0].as_array().unwrap().len(), 627);
    assert_eq!(value["items"][0]["shape"]["data"].as_array().unwrap().len(), 439);
    for clearance in [None, Some(2.0)] {
        for continuous in [false, true] {
            let mut external: ExtSPInstance = serde_json::from_str(INPUT).unwrap();
            if continuous {
                external.items[0].base.allowed_orientations = None;
            }
            let config = solver_config("standard", 3, None).unwrap();
            eprintln!("circle parse/apply clearance={clearance:?} continuous={continuous}");
            let constraints = stock::parse(INPUT, external.strip_height).unwrap();
            let importer = Importer::new(config.cde_config, config.poly_simpl_tolerance,
                clearance, config.narrow_concavity_cutoff_ratio);
            let instance = stock::apply(import_instance(&importer, &external).unwrap(), constraints).unwrap();
            for (item, _) in &instance.items {
                assert!(!item.shape_cd.surrogate().poles.is_empty());
            }
            let holes = &instance.stock_constraints.as_ref().unwrap().holes.shapes_cd;
            assert!(!holes.is_empty());
            for hole in holes {
                assert!(!hole.surrogate().poles.is_empty());
            }
            eprintln!("circle imported: {} fixed hazards", holes.len());
            for seed in [42, 1, 123] {
                eprintln!("circle LBF seed={seed} clearance={clearance:?} continuous={continuous}");
                let builder = LBFBuilder::new(instance.clone(), Xoshiro256PlusPlus::seed_from_u64(seed),
                    LBF_SAMPLE_CONFIG).construct().unwrap();
                assert_eq!(builder.prob.layout.placed_items.len(), 30);
                assert!(builder.prob.layout.is_feasible());
                for workers in [1, 3] {
                    eprintln!("circle optimize seed={seed} workers={workers} clearance={clearance:?} continuous={continuous}");
                    let mut config = solver_config("standard", workers, None).unwrap();
                    config.expl_cfg.time_limit = Duration::from_millis(100);
                    config.cmpr_cfg.time_limit = Duration::from_millis(100);
                    config.expl_cfg.max_conseq_failed_attempts = Some(1);
                    for separator in [&mut config.expl_cfg.separator_config, &mut config.cmpr_cfg.separator_config] {
                        separator.n_workers = workers;
                        separator.iter_no_imprv_limit = 1;
                        separator.strike_limit = 1;
                        separator.sample_config.n_container_samples = 2;
                        separator.sample_config.n_focussed_samples = 1;
                        separator.sample_config.n_coord_descents = 1;
                    }
                    let mut listener = Listener::default();
                    let solution = optimize(instance.clone(), Xoshiro256PlusPlus::seed_from_u64(seed),
                        &mut listener, &mut BasicTerminator::new(), &config.expl_cfg, &config.cmpr_cfg,
                        None).unwrap();
                    assert_eq!(listener.phases, [OptimizationPhase::Exploration, OptimizationPhase::Compression]);
                    assert_eq!(listener.finals, 1);
                    assert!(listener.separations > 0);
                    let mut restored = jagua_rs::probs::spp::entities::SPProblem::new(instance.clone());
                    restored.restore(&solution);
                    assert!(restored.layout.is_feasible());
                    eprintln!("circle passed seed={seed} workers={workers} width={} separations={}",
                        solution.strip.width, listener.separations);
                }
            }
        }
    }
}
