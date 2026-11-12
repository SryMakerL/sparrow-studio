use crate::eval::lbf_evaluator::LBFEvaluator;
use crate::eval::sample_eval::{SampleEval, SampleEvaluator};
use crate::sample::board_sampler::{BoardSampler, contains_in_board};
use crate::util::listener::{ReportType, SolutionListener};
use crate::util::terminator::Terminator;
use jagua_rs::collision_detection::hazards::{HazardEntity, collector::BasicHazardCollector};
use jagua_rs::entities::{Instance, Item, Layout, PItemKey};
use jagua_rs::geometry::geo_enums::RotationRange;
use jagua_rs::geometry::geo_traits::TransformableFrom;
use jagua_rs::geometry::primitives::{Rect, SPolygon};
use jagua_rs::geometry::{DTransformation, Transformation};
use jagua_rs::probs::spp::entities::{
    SPBoardDomain, SPInstance, SPPlacement, SPProblem, SPSolution,
};
use rand::{Rng, RngExt};

const MAX_SOURCES: usize = 3;
const MAX_MOVED: usize = 12;
const MAX_BLOCKERS: usize = 4;
const RESTARTS: usize = 3;
const MAX_PROBES: usize = 256;
const MAX_PATCHES: usize = 8;
const MAX_EVALS: usize = 24_000;

/// Evacuates at most three lightly loaded boards, without changing stock identity.
/// Work is bounded by source, moved-item, neighborhood, restart and evaluation caps.
/// Failure (including cancellation before an improvement) returns the original snapshot.
pub fn evacuate_boards(
    instance: &SPInstance,
    initial: &SPSolution,
    rng: &mut impl Rng,
    term: &impl Terminator,
    listener: &mut impl SolutionListener,
) -> SPSolution {
    let Some(stock) = instance.stock_constraints.as_ref() else {
        return initial.clone();
    };
    if stock.boards.len() < 2
        || term.kill()
        || !instance.matches_stock_constraints(&initial.stock_constraints)
    {
        return initial.clone();
    }
    let boards = &stock.boards;
    let mut problem = SPProblem::new(instance.clone());
    problem.restore(initial);
    if !complete(&problem, term) {
        return initial.clone();
    }
    let Some(mut groups) = classify(&problem, boards, term) else {
        return initial.clone();
    };
    let mut sources: Vec<_> = (0..boards.len())
        .filter(|&i| !groups[i].is_empty())
        .collect();
    sources.sort_by(|&a, &b| {
        groups[a].len().cmp(&groups[b].len()).then_with(|| {
            let area = |i: usize| {
                groups[i]
                    .iter()
                    .map(|&pk| problem.layout.placed_items[pk].shape.area)
                    .sum::<f32>()
            };
            area(a).total_cmp(&area(b))
        })
    });
    sources.truncate(MAX_SOURCES);
    let mut best = initial.clone();
    let mut budget = MAX_EVALS;
    for source in sources {
        if term.kill() || budget == 0 {
            break;
        }
        problem.restore(&best);
        let Some(current) = classify(&problem, boards, term) else {
            break;
        };
        groups = current;
        let used = groups.iter().filter(|g| !g.is_empty()).count();
        if used < 2 || groups[source].is_empty() || groups[source].len() > MAX_MOVED {
            continue;
        }
        let targets: Vec<_> = (0..boards.len())
            .filter(|&i| i != source && !groups[i].is_empty())
            .collect();
        // A non-rightmost board can be evacuated into stock beyond the current strip.
        if problem.strip_width() < stock.max_width {
            problem.change_strip_width(stock.max_width);
        }
        let mut moving: Vec<_> = groups[source]
            .iter()
            .map(|&pk| problem.remove_item(pk))
            .collect();
        sort_moving(&mut moving, instance);
        let base = problem.save();
        let mut accepted = false;
        for _ in 0..RESTARTS {
            if term.kill() || budget == 0 {
                break;
            }
            problem.restore(&base);
            if reinsert(
                &mut problem,
                &moving,
                boards,
                &targets,
                rng,
                term,
                &mut budget,
            ) && acceptable(&problem, boards, source, used, term)
            {
                accepted = true;
                break;
            }
        }
        if !accepted {
            problem.restore(&base);
            // Probe blocked placements in the source-removed layout. Only original
            // target residents may join a patch; no recursive displacement chain.
            let mut patches = Vec::<Vec<PItemKey>>::new();
            'items: for placement in &moving {
                for &target in &targets {
                    if term.kill() || budget == 0 || patches.len() >= MAX_PATCHES {
                        break 'items;
                    }
                    let item = instance.item(placement.item_id);
                    let candidates = candidates(&problem.layout, item, &boards[target], rng, term);
                    let mut shape = item.shape_cd.as_ref().clone();
                    for dt in candidates {
                        if term.kill() || budget == 0 {
                            break 'items;
                        }
                        budget -= 1;
                        shape.transform_from(&item.shape_cd, &dt.into());
                        if !contains_in_board(&boards[target], &shape) {
                            continue;
                        }
                        let mut collisions = BasicHazardCollector::new();
                        problem
                            .layout
                            .cde()
                            .collect_poly_collisions(&shape, &mut collisions);
                        let mut blockers = Vec::new();
                        let mut fixed = false;
                        for (_, entity) in collisions.iter() {
                            match entity {
                                HazardEntity::PlacedItem { pk, .. }
                                    if groups[target].contains(pk) =>
                                {
                                    blockers.push(*pk)
                                }
                                _ => {
                                    fixed = true;
                                    break;
                                }
                            }
                        }
                        if !fixed
                            && !blockers.is_empty()
                            && blockers.len() <= MAX_BLOCKERS
                            && moving.len() + blockers.len() <= MAX_MOVED
                            && !patches.iter().any(|p| {
                                p.len() == blockers.len() && p.iter().all(|k| blockers.contains(k))
                            })
                        {
                            patches.push(blockers);
                            if patches.len() >= MAX_PATCHES {
                                break 'items;
                            }
                        }
                    }
                }
            }
            'patches: for blockers in patches {
                if term.kill() || budget == 0 {
                    break;
                }
                problem.restore(&base);
                let mut patch = moving.clone();
                patch.extend(blockers.iter().map(|&pk| problem.remove_item(pk)));
                sort_moving(&mut patch, instance);
                let patch_base = problem.save();
                for _ in 0..RESTARTS {
                    if term.kill() || budget == 0 {
                        break 'patches;
                    }
                    problem.restore(&patch_base);
                    if reinsert(
                        &mut problem,
                        &patch,
                        boards,
                        &targets,
                        rng,
                        term,
                        &mut budget,
                    ) && acceptable(&problem, boards, source, used, term)
                    {
                        accepted = true;
                        break 'patches;
                    }
                }
            }
        }
        if accepted && !term.kill() {
            best = problem.save();
            listener.report(ReportType::ExplFeas, &best, instance);
        }
    }
    best
}

fn sort_moving(moving: &mut [SPPlacement], instance: &SPInstance) {
    moving.sort_by(|a, b| {
        instance
            .item(b.item_id)
            .shape_cd
            .area
            .total_cmp(&instance.item(a.item_id).shape_cd.area)
    });
}

fn complete(problem: &SPProblem, term: &impl Terminator) -> bool {
    if term.kill() || problem.item_demand_qtys.iter().any(|&q| q != 0) {
        return false;
    }
    // Unlike Layout::is_feasible this checks cancellation between every item.
    problem.layout.placed_items.iter().all(|(pk, pi)| {
        if term.kill() {
            return false;
        }
        let key = problem.layout.cde().haz_key_from_pi_key(pk).unwrap();
        !problem.layout.cde().detect_poly_collision(&pi.shape, &key)
    })
}

fn bbox_inside(inner: Rect, outer: Rect) -> bool {
    inner.x_min >= outer.x_min
        && inner.x_max <= outer.x_max
        && inner.y_min >= outer.y_min
        && inner.y_max <= outer.y_max
}

fn classify(
    problem: &SPProblem,
    boards: &[SPBoardDomain],
    term: &impl Terminator,
) -> Option<Vec<Vec<PItemKey>>> {
    let mut groups = vec![Vec::new(); boards.len()];
    for (pk, pi) in &problem.layout.placed_items {
        if term.kill() {
            return None;
        }
        let board = boards.iter().position(|b| {
            bbox_inside(pi.shape.bbox, b.outer.bbox) && contains_in_board(b, &pi.shape)
        })?;
        groups[board].push(pk);
    }
    Some(groups)
}

fn acceptable(
    problem: &SPProblem,
    boards: &[SPBoardDomain],
    source: usize,
    previous_used: usize,
    term: &impl Terminator,
) -> bool {
    complete(problem, term)
        && classify(problem, boards, term).is_some_and(|groups| {
            groups[source].is_empty()
                && groups.iter().filter(|g| !g.is_empty()).count() < previous_used
        })
}

struct TargetEvaluator<'a, T> {
    collision: LBFEvaluator<'a>,
    board: &'a SPBoardDomain,
    item: &'a Item,
    shape: SPolygon,
    term: &'a T,
}

impl<T: Terminator> SampleEvaluator for TargetEvaluator<'_, T> {
    fn stock_boards(&self) -> &[SPBoardDomain] {
        std::slice::from_ref(self.board)
    }
    fn evaluate_sample(&mut self, dt: DTransformation, upper: Option<SampleEval>) -> SampleEval {
        if self.term.kill() {
            return SampleEval::Invalid;
        }
        self.shape.transform_from(&self.item.shape_cd, &dt.into());
        if !contains_in_board(self.board, &self.shape) {
            return SampleEval::Invalid;
        }
        self.collision.evaluate_sample(dt, upper)
    }
    fn n_evals(&self) -> usize {
        self.collision.n_evals()
    }
}

fn reinsert(
    problem: &mut SPProblem,
    moving: &[SPPlacement],
    boards: &[SPBoardDomain],
    targets: &[usize],
    rng: &mut impl Rng,
    term: &impl Terminator,
    budget: &mut usize,
) -> bool {
    for placement in moving {
        if term.kill() || *budget == 0 {
            return false;
        }
        let item = problem.instance.item(placement.item_id);
        let mut found = None;
        for &target in targets {
            let mut evaluator = TargetEvaluator {
                collision: LBFEvaluator::new(&problem.layout, item),
                board: &boards[target],
                item,
                shape: item.shape_cd.as_ref().clone(),
                term,
            };
            for dt in candidates(&problem.layout, item, &boards[target], rng, term) {
                if term.kill() || *budget == 0 {
                    return false;
                }
                *budget -= 1;
                if matches!(
                    evaluator.evaluate_sample(dt, None),
                    SampleEval::Clear { .. }
                ) {
                    found = Some(dt);
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }
        let Some(d_transf) = found else {
            return false;
        };
        problem.place_item(SPPlacement {
            item_id: placement.item_id,
            d_transf,
        });
    }
    true
}

fn candidates(
    layout: &Layout,
    item: &Item,
    board: &SPBoardDomain,
    rng: &mut impl Rng,
    term: &impl Terminator,
) -> Vec<DTransformation> {
    let rotations = match &item.allowed_rotation {
        RotationRange::None => vec![0.0],
        RotationRange::Discrete(r) => r.clone(),
        RotationRange::Continuous => (0..16)
            .map(|i| i as f32 * std::f32::consts::TAU / 16.0)
            .collect(),
    };
    let mut result = Vec::new();
    let mut shape = item.shape_cd.as_ref().clone();
    let mut bounds = Vec::new();
    let outer = board.outer.bbox;
    for rotation in rotations {
        if term.kill() {
            return result;
        }
        let bbox = shape
            .transform_from(&item.shape_cd, &Transformation::from_rotation(rotation))
            .bbox;
        let x = (outer.x_min - bbox.x_min, outer.x_max - bbox.x_max);
        let y = (outer.y_min - bbox.y_min, outer.y_max - bbox.y_max);
        if x.0 > x.1 || y.0 > y.1 {
            continue;
        }
        bounds.push((rotation, bbox, x, y));
    }
    // Interleave orientations so a later fitting rotation cannot be starved.
    for corner in 0..4 {
        for &(r, _, x, y) in &bounds {
            result.push(DTransformation::new(
                r,
                (
                    if corner % 2 == 0 { x.0 } else { x.1 },
                    if corner < 2 { y.0 } else { y.1 },
                ),
            ));
        }
    }
    let anchors: Vec<_> = layout
        .placed_items
        .values()
        .filter(|p| bbox_inside(p.shape.bbox, outer))
        .take(24)
        .map(|p| p.shape.bbox)
        .collect();
    for anchor in &anchors {
        for &(r, b, x, y) in &bounds {
            for (px, py) in [
                (anchor.x_max - b.x_min, y.0),
                (anchor.x_min - b.x_max, y.0),
                (x.0, anchor.y_max - b.y_min),
                (x.0, anchor.y_min - b.y_max),
                (anchor.x_max - b.x_min, anchor.y_min - b.y_min),
                (anchor.x_min - b.x_max, anchor.y_min - b.y_min),
            ] {
                if px >= x.0 && px <= x.1 && py >= y.0 && py <= y.1 && result.len() < MAX_PROBES / 2
                {
                    result.push(DTransformation::new(r, (px, py)));
                }
            }
        }
    }
    let domains = std::slice::from_ref(board);
    if let Some(mut sampler) =
        BoardSampler::new(domains, item, outer, layout.container.outer_cd.bbox)
    {
        for i in result.len()..MAX_PROBES {
            if term.kill() {
                break;
            }
            let dt = if i % 2 == 0 {
                sampler.sample_edge(domains, item, &anchors, rng)
            } else {
                sampler.sample(domains, item, rng)
            };
            if let Some(dt) = dt {
                result.push(dt);
            }
        }
    }
    // Restart streams differ even when the deterministic corner candidates coincide.
    if result.len() > 4 && rng.random_range(0..RESTARTS) != 0 {
        let offset = rng.random_range(0..result.len());
        result.rotate_left(offset);
    }
    result.truncate(MAX_PROBES);
    result
}
