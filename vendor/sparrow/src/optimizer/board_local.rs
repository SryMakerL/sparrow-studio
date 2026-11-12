use crate::config::{CompressionConfig, DEFAULT_SPARROW_CONFIG, SparrowConfig};
use crate::optimizer::compress::compression_phase;
use crate::optimizer::explore::exploration_phase;
use crate::optimizer::separator::Separator;
use crate::sample::board_sampler::contains_in_board;
use crate::util::listener::{
    DummySolListener, OptimizationPhase, ReportType, SeparationProgress, SeparationResult,
    SolutionListener,
};
use crate::util::terminator::Terminator;
use jagua_rs::Instant;
use jagua_rs::entities::{Instance, Layout, PItemKey};
use jagua_rs::geometry::geo_traits::Transformable;
use jagua_rs::geometry::primitives::Rect;
use jagua_rs::geometry::shape_modification::ShapeModifyConfig;
use jagua_rs::geometry::{DTransformation, Transformation};
use jagua_rs::probs::spp::entities::{
    SPBoardDomain, SPInstance, SPPlacement, SPProblem, SPSolution, SPStockConstraints, Strip,
};
use rand::{Rng, SeedableRng, rngs::Xoshiro256PlusPlus};
use std::time::Duration;

#[path = "board_local_geometry.rs"]
mod geometry;

/// Physical-board assignment and length measured from the board's fixed left edge.
#[derive(Debug, Clone, PartialEq)]
pub struct BoardUsage {
    pub keys: Vec<PItemKey>,
    pub used_length: f32,
}

/// Classifies existing placements without constructing containers or modifying stock.
/// None means foreign stock identity or an item not wholly inside one physical board.
pub fn board_usage(instance: &SPInstance, solution: &SPSolution) -> Option<Vec<BoardUsage>> {
    if !instance.matches_stock_constraints(&solution.stock_constraints) {
        return None;
    }
    let boards = &instance.stock_constraints.as_ref()?.boards;
    let mut usage: Vec<_> = boards
        .iter()
        .map(|_| BoardUsage {
            keys: Vec::new(),
            used_length: 0.0,
        })
        .collect();
    for (key, item) in &solution.layout_snapshot.placed_items {
        let index = boards.iter().position(|b| {
            inside_bbox(item.shape.bbox, b.outer.bbox) && contains_in_board(b, &item.shape)
        })?;
        usage[index].keys.push(key);
        usage[index].used_length = usage[index]
            .used_length
            .max(item.shape.bbox.x_max - boards[index].outer.bbox.x_min);
    }
    Some(usage)
}

/// Compatibility entry point. The supplied duration is the entire local budget,
/// split 80/20 between the original Sparrow exploration and compression phases.
pub fn compact_board(
    instance: &SPInstance,
    initial: &SPSolution,
    board_index: usize,
    rng: &mut impl Rng,
    term: &impl Terminator,
    config: &CompressionConfig,
) -> SPSolution {
    let mut full = DEFAULT_SPARROW_CONFIG;
    full.expl_cfg.time_limit = config.time_limit.mul_f64(0.8);
    full.cmpr_cfg = *config;
    full.cmpr_cfg.time_limit = config.time_limit.saturating_sub(full.expl_cfg.time_limit);
    compact_board_sparrow(
        instance,
        initial,
        board_index,
        rng,
        term,
        &full,
        &mut DummySolListener,
    )
}

/// Run Sparrow's original exploration/compression + Separator on this board's
/// existing residents, allowing infeasible intermediate layouts. The full config's
/// two durations share one absolute deadline; neither retries nor phase transitions
/// reset it. Only validated global snapshots are ever sent to the listener.
pub fn compact_board_sparrow(
    instance: &SPInstance,
    initial: &SPSolution,
    board_index: usize,
    rng: &mut impl Rng,
    term: &impl Terminator,
    config: &SparrowConfig,
    listener: &mut impl SolutionListener,
) -> SPSolution {
    let start = Instant::now();
    let total = config
        .expl_cfg
        .time_limit
        .saturating_add(config.cmpr_cfg.time_limit);
    if term.kill() || total.is_zero() {
        return initial.clone();
    }
    let Some(usage) = board_usage(instance, initial) else {
        return initial.clone();
    };
    let Some(selected) = usage.get(board_index) else {
        return initial.clone();
    };
    if selected.keys.is_empty() {
        return initial.clone();
    }
    let mut quantities = vec![0usize; instance.items.len()];
    for item in initial.layout_snapshot.placed_items.values() {
        let Some(qty) = quantities.get_mut(item.item_id) else {
            return initial.clone();
        };
        *qty += 1;
    }
    if quantities
        .iter()
        .enumerate()
        .any(|(id, &qty)| qty != instance.item_qty(id))
    {
        return initial.clone();
    }
    let global = SPProblem {
        instance: instance.clone(),
        strip: initial.strip,
        layout: Layout::from_snapshot(&initial.layout_snapshot),
        item_demand_qtys: vec![0; quantities.len()],
    };
    if !global.layout.is_feasible() || term.kill() {
        return initial.clone();
    }
    let board = &instance.stock_constraints.as_ref().unwrap().boards[board_index];
    let Some((local, translation)) = local_problem(instance, initial, board, &selected.keys) else {
        return initial.clone();
    };
    if !local.layout.is_feasible() {
        return initial.clone();
    }
    let deadline = term
        .timeout_at()
        .map_or(start + total, |end| end.min(start + total));
    let exploration_end = (start + config.expl_cfg.time_limit).min(deadline);
    let local_instance = local.instance.clone();
    let mut local_best = local.save();
    let mut sink = GlobalListener {
        instance,
        initial,
        board_index,
        keys: &selected.keys,
        translation,
        best: initial.clone(),
        best_length: selected.used_length,
        listener,
    };

    if Instant::now() < exploration_end && !term.kill() {
        sink.report_phase(OptimizationPhase::Exploration);
        let phase_term = LocalTerm {
            parent: term,
            deadline: exploration_end,
        };
        let mut separator = Separator::new(
            local_instance.clone(),
            local.clone(),
            Xoshiro256PlusPlus::seed_from_u64(rng.next_u64()),
            config.expl_cfg.separator_config,
        );
        while !phase_term.kill() {
            separator.prob.restore(&local_best);
            separator.rollback(&local_best, None);
            let solutions = exploration_phase(
                &local_instance,
                &mut separator,
                &mut sink,
                &phase_term,
                &config.expl_cfg,
            );
            local_best = solutions.last().unwrap().clone();
            if at_lower_bound(&separator.prob, &local_best) {
                break;
            }
        }
    }
    if Instant::now() < deadline && !term.kill() && !config.cmpr_cfg.time_limit.is_zero() {
        sink.report_phase(OptimizationPhase::Compression);
        let phase_term = LocalTerm {
            parent: term,
            deadline,
        };
        let mut problem = local;
        problem.restore(&local_best);
        let mut separator = Separator::new(
            local_instance.clone(),
            problem,
            Xoshiro256PlusPlus::seed_from_u64(rng.next_u64()),
            config.cmpr_cfg.separator_config,
        );
        while !phase_term.kill() {
            let mut cfg = config.cmpr_cfg;
            cfg.time_limit = deadline.saturating_duration_since(Instant::now());
            local_best = compression_phase(
                &local_instance,
                &mut separator,
                &local_best,
                &mut sink,
                &phase_term,
                &cfg,
            );
            sink.accept(ReportType::CmprFeas, &local_best);
            if at_lower_bound(&separator.prob, &local_best) {
                break;
            }
        }
    }
    // A timeout is not a user stop. In particular, never discard a feasible
    // improvement just because the caller's shared timeout expired during search.
    if term.kill() && term.timeout_at().is_none_or(|end| Instant::now() < end) {
        initial.clone()
    } else {
        sink.best
    }
}

fn local_problem(
    instance: &SPInstance,
    initial: &SPSolution,
    board: &SPBoardDomain,
    keys: &[PItemKey],
) -> Option<(SPProblem, (f32, f32))> {
    let bbox = board.outer.bbox;
    let padding = (initial.strip.shape_modify_config.offset.unwrap_or(0.0) + 1.0)
        .max(bbox.width().max(bbox.height()) * 0.0001);
    let translation = (padding - bbox.x_min, padding - bbox.y_min);
    let transform = Transformation::from_translation(translation);
    let clip = Rect::try_new(
        bbox.x_min - padding,
        bbox.y_min - padding,
        bbox.x_max + padding,
        bbox.y_max + padding,
    )
    .ok()?;
    let mut holes = geometry::local_hazards(
        &initial.layout_snapshot.container,
        clip,
        translation,
        initial.strip.cde_config,
    )?;
    // The padding keeps the new strip's boundary away from true stock edges.
    // Original complement hazards retain their half-clearance semantics. These
    // extra walls retain the old outer rectangle's already-prepared inset.
    let old_outer = initial.layout_snapshot.container.outer_cd.bbox;
    let allowed = Rect::try_new(
        bbox.x_min.max(old_outer.x_min),
        bbox.y_min.max(old_outer.y_min),
        bbox.x_max.min(old_outer.x_max),
        bbox.y_max.min(old_outer.y_max),
    )
    .ok()?;
    let width = bbox.width() + 2.0 * padding;
    let height = bbox.height() + 2.0 * padding;
    geometry::add_walls(
        &mut holes,
        allowed,
        translation,
        width,
        height,
        initial.strip.cde_config,
    )?;
    let domain = SPBoardDomain {
        outer: board.outer.transform_clone(&transform),
        holes: board
            .holes
            .iter()
            .map(|hole| hole.transform_clone(&transform))
            .collect(),
    };
    let mut local_instance = instance.clone();
    for (_, qty) in &mut local_instance.items {
        *qty = 0;
    }
    let mut right = 0.0_f32;
    for &key in keys {
        let item = &initial.layout_snapshot.placed_items[key];
        local_instance.items[item.item_id].1 += 1;
        right = right.max(item.shape.bbox.x_max - bbox.x_min + padding);
    }
    let slack = (right * 0.00001).max(0.00001);
    local_instance.base_strip = Strip::new(
        height,
        initial.strip.cde_config,
        ShapeModifyConfig::default(),
        (right + slack).min(width),
    )
    .ok()?;
    local_instance.stock_constraints = Some(std::sync::Arc::new(SPStockConstraints {
        max_width: width,
        holes,
        boards: vec![domain],
    }));
    let mut problem = SPProblem::new(local_instance);
    for &key in keys {
        let item = &initial.layout_snapshot.placed_items[key];
        let (x, y) = item.d_transf.translation();
        problem.place_item(SPPlacement {
            item_id: item.item_id,
            d_transf: DTransformation::new(
                item.d_transf.rotation(),
                (x + translation.0, y + translation.1),
            ),
        });
    }
    Some((problem, translation))
}

fn at_lower_bound(problem: &SPProblem, solution: &SPSolution) -> bool {
    let min = super::minimum_strip_width(problem);
    solution.strip_width() <= min + min.abs().max(1.0) * 0.00001
}

struct LocalTerm<'a, T> {
    parent: &'a T,
    deadline: Instant,
}
impl<T: Terminator> Terminator for LocalTerm<'_, T> {
    fn kill(&self) -> bool {
        self.parent.kill() || Instant::now() >= self.deadline
    }
    fn new_timeout(&mut self, _: Duration) {}
    fn timeout_at(&self) -> Option<Instant> {
        Some(self.deadline)
    }
}

struct GlobalListener<'a, L> {
    instance: &'a SPInstance,
    initial: &'a SPSolution,
    board_index: usize,
    keys: &'a [PItemKey],
    translation: (f32, f32),
    best: SPSolution,
    best_length: f32,
    listener: &'a mut L,
}

impl<L: SolutionListener> GlobalListener<'_, L> {
    fn accept(&mut self, report: ReportType, candidate: &SPSolution) {
        if candidate.layout_snapshot.placed_items.len() != self.keys.len() {
            return;
        }
        let mut required = vec![0usize; self.instance.items.len()];
        for &key in self.keys {
            required[self.initial.layout_snapshot.placed_items[key].item_id] += 1;
        }
        let mut placements = Vec::with_capacity(self.keys.len());
        for item in candidate.layout_snapshot.placed_items.values() {
            let Some(qty) = required.get_mut(item.item_id) else {
                return;
            };
            if *qty == 0 {
                return;
            }
            *qty -= 1;
            let (x, y) = item.d_transf.translation();
            placements.push(SPPlacement {
                item_id: item.item_id,
                d_transf: DTransformation::new(
                    item.d_transf.rotation(),
                    (x - self.translation.0, y - self.translation.1),
                ),
            });
        }
        if required.iter().any(|&qty| qty != 0) {
            return;
        }
        let mut global = SPProblem {
            instance: self.instance.clone(),
            strip: self.initial.strip,
            layout: Layout::from_snapshot(&self.initial.layout_snapshot),
            item_demand_qtys: vec![0; required.len()],
        };
        for &key in self.keys {
            global.remove_item(key);
        }
        for placement in placements {
            global.place_item(placement);
        }
        if !global.layout.is_feasible() {
            return;
        }
        let result = global.save();
        let Some(usage) = board_usage(self.instance, &result) else {
            return;
        };
        let length = usage[self.board_index].used_length;
        if usage[self.board_index].keys.len() != self.keys.len() || length >= self.best_length {
            return;
        }
        // Keys belonging to other boards were never removed, replaced or moved.
        let selected = &self.instance.stock_constraints.as_ref().unwrap().boards[self.board_index];
        if global.layout.placed_items.iter().any(|(key, item)| {
            !self.initial.layout_snapshot.placed_items.contains_key(key)
                && !(inside_bbox(item.shape.bbox, selected.outer.bbox)
                    && contains_in_board(selected, &item.shape))
        }) {
            return;
        }
        self.best_length = length;
        self.best = result;
        self.listener.report(report, &self.best, self.instance);
    }
}

impl<L: SolutionListener> SolutionListener for GlobalListener<'_, L> {
    fn report(&mut self, report: ReportType, solution: &SPSolution, _: &SPInstance) {
        if matches!(
            report,
            ReportType::ExplFeas | ReportType::CmprFeas | ReportType::Final
        ) {
            self.accept(report, solution);
        }
    }
    fn report_phase(&mut self, phase: OptimizationPhase) {
        self.listener.report_phase(phase);
    }
    fn report_separation_progress(&mut self, mut progress: SeparationProgress) {
        progress.strip_width = self.initial.strip_width();
        progress.density = self.best.density(self.instance) * 100.0;
        self.listener.report_separation_progress(progress);
    }
    fn report_separation_result(&mut self, result: SeparationResult) {
        self.listener.report_separation_result(result);
    }
    fn report_compression_progress(&mut self, shrink_step: f32) {
        self.listener.report_compression_progress(shrink_step);
    }
}

fn inside_bbox(inner: Rect, outer: Rect) -> bool {
    inner.x_min >= outer.x_min
        && inner.x_max <= outer.x_max
        && inner.y_min >= outer.y_min
        && inner.y_max <= outer.y_max
}
