use super::*;
use crate::optimizer::separator::{SeparatorConfig, SeparationOutcome};
use crate::util::listener::DummySolListener;
use jagua_rs::collision_detection::CDEConfig;
use jagua_rs::entities::Item;
use jagua_rs::geometry::{DTransformation, OriginalShape, fail_fast::SPSurrogateConfig,
    geo_enums::RotationRange, primitives::Rect,
    shape_modification::{ShapeModifyConfig, ShapeModifyMode}};
use jagua_rs::probs::spp::entities::{SPPlacement, Strip};
use rand::{Rng, SeedableRng};
use std::cell::Cell;

struct Steps(Cell<usize>);
impl Terminator for Steps {
    fn kill(&self) -> bool {
        let remaining = self.0.get();
        self.0.set(remaining.saturating_sub(1));
        remaining == 0
    }
    fn new_timeout(&mut self, _: Duration) {}
    fn timeout_at(&self) -> Option<Instant> { None }
}

fn state() -> CompressionState {
    let surrogate = SPSurrogateConfig::none();
    let cde = CDEConfig { quadtree_depth: 4, cd_threshold: 16, item_surrogate_config: surrogate };
    let original = |w, h| OriginalShape {
        shape: Rect::try_new(0.0, 0.0, w, h).unwrap().into(),
        pre_transform: DTransformation::empty(),
        modify_mode: ShapeModifyMode::Inflate,
        modify_config: ShapeModifyConfig::default(),
    };
    let item = Item::new(0, original(4.0, 4.0), RotationRange::None, None, surrogate).unwrap();
    let unused = Item::new(1, original(100.0, 100.0), RotationRange::None, None, surrogate).unwrap();
    let instance = SPInstance::new(vec![(item, 4), (unused, 0)],
        Strip::new(10.0, cde, ShapeModifyConfig::default(), 10.0).unwrap());
    let mut prob = SPProblem::new(instance.clone());
    for position in [(0.0, 0.0), (4.0, 0.0), (0.0, 4.0), (4.0, 4.0)] {
        prob.place_item(SPPlacement { item_id: 0, d_transf: DTransformation::new(0.0, position) });
    }
    CompressionState::new(instance, prob.save(), Xoshiro256PlusPlus::seed_from_u64(42), CompressionConfig {
        shrink_range: (0.25, 0.03),
        time_limit: Duration::from_secs(60),
        shrink_decay: ShrinkDecayStrategy::FailureBased(0.5),
        separator_config: SeparatorConfig {
            iter_no_imprv_limit: 2, strike_limit: 2, n_workers: 1,
            log_level: log::Level::Debug,
            sample_config: crate::sample::search::SampleConfig {
                n_container_samples: 4, n_focussed_samples: 4, n_coord_descents: 1,
            },
        },
    })
}

fn fingerprint(state: &CompressionState) -> String {
    format!("{:?}|{:?}|{:?}|{:?}|{}|{}|{}|{:?}",
        state.best.strip, state.best.layout_snapshot, state.separator.prob.layout.placed_items,
        state.separator.ct, state.failed_attempts, state.attempts, state.shrink_step,
        state.finished)
}

#[test]
fn sliced_compression_matches_uninterrupted_including_rng_and_counts() {
    let mut full = state();
    let mut sliced = state();
    let mut listener = DummySolListener;
    let expected = full.advance(&Steps(Cell::new(usize::MAX)), &mut listener);
    assert_ne!(expected, CompressionOutcome::Paused);
    let mut pauses = 0;
    let actual = loop {
        let outcome = sliced.advance(&Steps(Cell::new(4)), &mut listener);
        if outcome != CompressionOutcome::Paused { break outcome; }
        pauses += 1;
        assert!(pauses < 1000);
    };
    assert!(pauses > 0);
    assert!(full.failed_attempts > 0);
    assert_eq!(expected, actual);
    assert_eq!(fingerprint(&full), fingerprint(&sliced));
    assert_eq!(full.separator.rng.next_u64(), sliced.separator.rng.next_u64());
    for (a, b) in full.separator.workers.iter_mut().zip(&mut sliced.separator.workers) {
        assert_eq!(a.rng.next_u64(), b.rng.next_u64());
    }
}

#[test]
fn zero_budget_does_not_change_checkpoint_or_count_failure() {
    let mut state = state();
    let before = fingerprint(&state);
    let rng = format!("{:?}", state.separator.rng);
    assert_eq!(state.advance(&Steps(Cell::new(0)), &mut DummySolListener), CompressionOutcome::Paused);
    assert_eq!(before, fingerprint(&state));
    assert_eq!(rng, format!("{:?}", state.separator.rng));
    assert!(state.separation.is_none());
    assert_eq!(state.active_elapsed, Duration::ZERO);
}

#[test]
fn inner_separation_resumes_without_reset_or_repeated_shrink() {
    let mut state = state();
    assert_eq!(state.advance(&Steps(Cell::new(2)), &mut DummySolListener), CompressionOutcome::Paused);
    let pending = state.separation.as_ref().unwrap();
    assert_eq!(pending.iterations, 1);
    let width = state.separator.prob.strip_width();
    let rng = format!("{:?}", state.separator.rng);
    let counts = (pending.strikes, pending.no_improvement, pending.total_evals, pending.total_moves);
    let tracker = format!("{:?}", state.separator.ct);
    assert_eq!(state.advance(&Steps(Cell::new(0)), &mut DummySolListener), CompressionOutcome::Paused);
    let pending = state.separation.as_ref().unwrap();
    assert_eq!(counts, (pending.strikes, pending.no_improvement, pending.total_evals, pending.total_moves));
    assert_eq!(tracker, format!("{:?}", state.separator.ct));
    assert_eq!(state.failed_attempts, 0);
    assert_eq!(state.attempts, 1);
    assert_eq!(state.advance(&Steps(Cell::new(2)), &mut DummySolListener), CompressionOutcome::Paused);
    assert!(state.separation.as_ref().unwrap().iterations > 1);
    assert_eq!(state.separator.prob.strip_width(), width);
    assert_eq!(rng, format!("{:?}", state.separator.rng));
    assert_eq!(state.attempts, 1);
}

#[test]
fn separation_slices_preserve_strikes_weights_and_counters() {
    let mut full = state();
    let mut sliced = state();
    for state in [&mut full, &mut sliced] {
        state.separator.change_strip_width(7.5, Some(5.0));
    }
    let mut a = full.separator.start_separation();
    let mut b = sliced.separator.start_separation();
    let expected = full.separator.advance_separation(&mut a, &Steps(Cell::new(usize::MAX)), &mut DummySolListener);
    loop {
        if sliced.separator.advance_separation(&mut b, &Steps(Cell::new(1)), &mut DummySolListener) != SeparationOutcome::Paused { break; }
    }
    assert_eq!(expected, SeparationOutcome::Exhausted);
    assert_eq!((a.strikes, a.iterations, a.no_improvement, a.total_moves, a.total_evals),
        (b.strikes, b.iterations, b.no_improvement, b.total_moves, b.total_evals));
    assert_eq!(a.min_loss, b.min_loss);
    assert_eq!(format!("{:?}", full.separator.ct), format!("{:?}", sliced.separator.ct));
    assert_eq!(full.separator.workers[0].rng.next_u64(), sliced.separator.workers[0].rng.next_u64());
}

#[test]
fn time_decay_does_not_include_paused_wall_time() {
    let mut state = state();
    state.config.shrink_decay = ShrinkDecayStrategy::TimeBased;
    assert_eq!(state.advance(&Steps(Cell::new(2)), &mut DummySolListener), CompressionOutcome::Paused);
    let active = state.active_elapsed;
    let separation_active = state.separation.as_ref().unwrap().active_elapsed;
    std::thread::sleep(Duration::from_millis(25));
    assert_eq!(state.advance(&Steps(Cell::new(0)), &mut DummySolListener), CompressionOutcome::Paused);
    assert_eq!(state.active_elapsed, active);
    assert_eq!(state.separation.as_ref().unwrap().active_elapsed, separation_active);
}

#[test]
fn coarse_step_crossing_lower_bound_still_improves() {
    let mut state = state();
    state.config.shrink_range = (0.9, 0.03);
    let initial_width = state.best().strip_width();
    assert!(initial_width * (1.0 - state.config.shrink_range.0) < state.min_width);
    let outcome = state.advance(&Steps(Cell::new(usize::MAX)), &mut DummySolListener);
    assert_ne!(outcome, CompressionOutcome::Paused);
    assert!(state.attempts > 0);
    assert!(state.best().strip_width() < initial_width);
    assert!(state.best().strip_width() >= state.min_width);
}

#[test]
fn restart_only_after_exhaustion_preserves_separator_and_random_streams() {
    let mut state = state();
    assert_eq!(state.advance(&Steps(Cell::new(2)), &mut DummySolListener), CompressionOutcome::Paused);
    let paused = fingerprint(&state);
    let active = state.active_elapsed;
    let pending_iterations = state.separation.as_ref().unwrap().iterations;
    assert!(!state.restart_cycle());
    assert_eq!(fingerprint(&state), paused);
    assert_eq!(state.active_elapsed, active);
    assert_eq!(state.separation.as_ref().unwrap().iterations, pending_iterations);

    assert_eq!(state.advance(&Steps(Cell::new(usize::MAX)), &mut DummySolListener), CompressionOutcome::Exhausted);
    let rng = format!("{:?}", state.separator.rng);
    let workers = state.separator.workers.iter().map(|w| format!("{:?}", w.rng)).collect::<Vec<_>>();
    let layout = format!("{:?}", state.separator.prob.layout.placed_items);
    let tracker = format!("{:?}", state.separator.ct);
    let best = format!("{:?}", state.best().layout_snapshot);
    let attempts = state.attempts;
    assert!(state.restart_cycle());
    assert_eq!(state.failed_attempts, 0);
    assert_eq!(state.active_elapsed, Duration::ZERO);
    assert_eq!(state.finished, None);
    assert_eq!(state.shrink_step, state.config.shrink_range.0);
    assert!(state.separation.is_none());
    assert_eq!(state.attempts, attempts);
    assert_eq!(rng, format!("{:?}", state.separator.rng));
    assert_eq!(workers, state.separator.workers.iter().map(|w| format!("{:?}", w.rng)).collect::<Vec<_>>());
    assert_eq!(layout, format!("{:?}", state.separator.prob.layout.placed_items));
    assert_eq!(tracker, format!("{:?}", state.separator.ct));
    assert_eq!(best, format!("{:?}", state.best().layout_snapshot));
    assert!(!state.restart_cycle());
    state.min_width = state.best().strip_width();
    assert_eq!(state.advance(&Steps(Cell::new(usize::MAX)), &mut DummySolListener), CompressionOutcome::BoundReached);
    assert!(!state.restart_cycle());
}
