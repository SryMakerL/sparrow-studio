use crate::FMT;
use crate::config::ExplorationConfig;
use crate::optimizer::separator::{Separator, SeparatorConfig};
use crate::sample::uniform_sampler::{convert_sample_to_closest_feasible, UniformBBoxSampler};
use crate::util::listener::{ReportType, SeparationProgress, SeparationResult, SolutionListener};
use crate::util::terminator::Terminator;
use float_cmp::approx_eq;
use itertools::Itertools;
use jagua_rs::collision_detection::hazards::HazardEntity;
use jagua_rs::collision_detection::hazards::collector::BasicHazardCollector;
use jagua_rs::entities::{Instance, Layout, PItemKey};
use jagua_rs::geometry::geo_traits::CollidesWith;
use jagua_rs::probs::spp::entities::{SPInstance, SPSolution};
use log::{debug, info, warn};
use ordered_float::OrderedFloat;
use rand::prelude::{Distribution, IteratorRandom};
use rand_distr::Normal;
use std::cmp::Reverse;

/// Algorithm 12 from https://doi.org/10.48550/arXiv.2509.13329
pub fn exploration_phase(
    instance: &SPInstance,
    sep: &mut Separator,
    sol_listener: &mut impl SolutionListener,
    term: &impl Terminator,
    config: &ExplorationConfig,
) -> Vec<SPSolution> {
    let min_width = super::minimum_strip_width(&sep.prob);
    let mut current_width = sep.prob.strip_width();
    let mut best_width = current_width;

    let mut feasible_sols = vec![sep.prob.save()];

    sol_listener.report(ReportType::ExplFeas, &feasible_sols[0], instance);
    info!(
        "[EXPL] starting optimization with initial width: {:.3} ({:.3}%)",
        current_width,
        sep.prob.density() * 100.0
    );

    let mut infeas_sol_pool: Vec<(SPSolution, f32)> = vec![];
    let mut board_shrink = super::board_shrink::BoardShrink::new(&sep.prob);
    let mut board_failures = 0;

    while !term.kill() {
        // Attempt to separate the current layout
        let local_best = sep.separate(term, sol_listener);
        let total_loss = local_best.1.get_total_loss();

        if total_loss == 0.0 {
            // If successfully separated
            if current_width < best_width {
                info!(
                    "[EXPL] feasible solution found! (width: {:.3}, dens: {:.3}%)",
                    current_width,
                    sep.prob.density() * 100.0
                );
                best_width = current_width;
                feasible_sols.push(local_best.0.clone());
                sol_listener.report(ReportType::ExplFeas, &local_best.0, instance);
            }
            if let Some(policy) = &mut board_shrink {
                policy.succeeded();
                board_failures = 0;
            }
            let board_step = match &board_shrink {
                Some(policy) => match policy.step(&sep.prob, config.shrink_step) {
                    Some(step) => Some(step),
                    None => break,
                },
                None => None,
            };
            let next_width = board_step
                .map_or(current_width * (1.0 - config.shrink_step), |step| {
                    step.next_width
                });
            if next_width < min_width || next_width >= current_width {
                info!("[EXPL] stopping at minimum strip width: {:.3}", min_width);
                break;
            }
            info!(
                "[EXPL] shrinking strip: {:.3} -> {:.3}",
                current_width, next_width
            );
            let split_position = board_step.map(|step| (step.split_min + step.split_max) * 0.5);
            sep.change_strip_width(next_width, split_position);
            current_width = next_width;
            infeas_sol_pool.clear();
        } else {
            info!(
                "[EXPL] unable to reach feasibility (width: {:.3}, dens: {:.3}%, min loss: {})",
                current_width,
                sep.prob.density() * 100.0,
                FMT().fmt2(total_loss)
            );
            sol_listener.report(ReportType::ExplInfeas, &local_best.0, instance);

            if let Some(policy) = &mut board_shrink {
                board_failures += 1;
                if board_failures >= config.max_conseq_failed_attempts.unwrap_or(usize::MAX) {
                    break;
                }
                policy.failed();
                let feasible = feasible_sols.last().unwrap();
                sep.change_strip_width(feasible.strip_width(), None);
                sep.rollback(feasible, None);
                let Some(step) = policy.step(&sep.prob, config.shrink_step) else {
                    break;
                };
                if step.next_width < min_width {
                    break;
                }
                sep.change_strip_width(
                    step.next_width,
                    Some((step.split_min + step.split_max) * 0.5),
                );
                current_width = step.next_width;
                continue;
            }

            // Separation was not successful add it to the pool of infeasible solutions
            match infeas_sol_pool.binary_search_by(|(_, o)| o.partial_cmp(&total_loss).unwrap()) {
                Ok(idx) | Err(idx) => {
                    infeas_sol_pool.insert(idx, (local_best.0.clone(), total_loss))
                }
            }

            if infeas_sol_pool.len() >= config.max_conseq_failed_attempts.unwrap_or(usize::MAX) {
                info!(
                    "[EXPL] max consecutive failed attempts ({}), terminating",
                    infeas_sol_pool.len()
                );
                break;
            }

            // Restore to a random solution from the pool, with better solutions having more chance to be selected
            let selected_sol = {
                // Sample a value in range [0.0, 1.0[ from a normal distribution
                let distribution =
                    Normal::new(0.0, config.solution_pool_distribution_stddev).unwrap();
                let sample = distribution.sample(&mut sep.rng).abs().min(0.999);
                // Map it to an index in the infeasible solution pool (better solutions are at the start of the pool)
                let selected_idx = (sample * infeas_sol_pool.len() as f32) as usize;

                let (selected_sol, loss) = &infeas_sol_pool[selected_idx];
                info!(
                    "[EXPL] starting solution {}/{} selected from solution pool (l: {}) to disrupt",
                    selected_idx,
                    infeas_sol_pool.len(),
                    FMT().fmt2(*loss)
                );
                selected_sol
            };

            // Rollback to this solution and disrupt it.
            sep.rollback(selected_sol, None);
            disrupt_solution(sep, config);
        }
    }

    info!(
        "[EXPL] finished, best feasible solution: width: {:.3} ({:.3}%)",
        best_width,
        feasible_sols.last().unwrap().density(instance) * 100.0
    );

    feasible_sols
}

/// Search for alternative feasible placements without changing the strip width.
/// The initial solution must be feasible and have the separator's current width.
/// Intermediate layouts are private; callers publish the returned fallback or result.
pub fn rearrange(
    sep: &mut Separator,
    initial: &SPSolution,
    sol_listener: &mut impl SolutionListener,
    term: &impl Terminator,
) -> SPSolution {
    struct SearchListener<'a, L>(&'a mut L);
    impl<L: SolutionListener> SolutionListener for SearchListener<'_, L> {
        fn report(&mut self, _: ReportType, _: &SPSolution, _: &SPInstance) {}

        fn report_separation_progress(&mut self, progress: SeparationProgress) {
            self.0.report_separation_progress(progress);
        }

        fn report_separation_result(&mut self, result: SeparationResult) {
            self.0.report_separation_result(result);
        }
    }

    let mut best = initial.clone();
    let config = sep.config;
    // Keep each attempt short so termination is checked between actual searches.
    sep.config.iter_no_imprv_limit = 1;
    sep.config.strike_limit = 1;
    let mut listener = SearchListener(sol_listener);
    while !term.kill() {
        sep.rollback(&best, None);
        let Some((pk, pi)) = sep.prob.layout.placed_items.iter().choose(&mut sep.rng) else {
            break;
        };
        let item = sep.prob.instance.item(pi.item_id);
        let container = sep.prob.layout.container.outer_cd.bbox;
        let dt = UniformBBoxSampler::new(container, item, container)
            .map_or(pi.d_transf, |sampler| sampler.sample(&mut sep.rng));
        let pk = sep.move_item(pk, dt);
        if sep.ct.get_total_loss() == 0.0 {
            // Feasible sampling alone gives the worker nothing to search, notably
            // for a single item or identical items. Cross the left boundary by a
            // fraction of this item's width, leaving it overlapping the container.
            let pi = &sep.prob.layout.placed_items[pk];
            let dx = container.x_min - pi.shape.bbox.x_min - pi.shape.bbox.width() * 0.1;
            let dt = pi.d_transf.compose().translate((dx, 0.0)).decompose();
            sep.move_item(pk, dt);
        }
        if term.kill() {
            break;
        }
        let (solution, tracker) = sep.separate(term, &mut listener);
        if tracker.get_total_loss() == 0.0 && solution.strip_width() == initial.strip_width() {
            sep.rollback(&solution, Some(&tracker));
            if sep.prob.layout.is_feasible() {
                best = solution;
            }
        }
    }
    sep.config = config;
    sep.rollback(&best, None);
    best
}

fn disrupt_solution(sep: &mut Separator, config: &ExplorationConfig) {
    if sep.prob.layout.placed_items.len() < 2 {
        warn!("[DSRP] cannot disrupt solution with less than 2 items");
        return;
    }

    // The general idea is to disrupt a solution by swapping two 'large' items in the layout.
    // 'Large' items are those whose convex hull area falls within a certain top percentile
    // of the total convex hull area of all items in the layout.

    // Step 1: Define what constitutes a 'large' item.

    // Calculate the total convex hull area of all items, considering quantities.
    let total_convex_hull_area: f32 = sep
        .prob
        .instance
        .items
        .iter()
        .map(|(item, quantity)| item.shape_cd.surrogate().convex_hull_area * (*quantity as f32))
        .sum();

    let cutoff_threshold_area =
        total_convex_hull_area * config.large_item_ch_area_cutoff_percentile;

    // Sort items by convex hull area in descending order.
    let sorted_items_by_ch_area = sep
        .prob
        .instance
        .items
        .iter()
        .sorted_by_key(|(item, _)| {
            Reverse(OrderedFloat(item.shape_cd.surrogate().convex_hull_area))
        })
        .peekable();

    let mut cumulative_ch_area = 0.0;
    let mut ch_area_cutoff = 0.0;

    // Iterate through items, accumulating their convex hull areas until the cumulative sum
    // exceeds the cutoff_threshold_area. The convex hull area of the item that causes
    // this excess becomes the ch_area_cutoff.
    for (item, quantity) in sorted_items_by_ch_area {
        let item_ch_area = item.shape_cd.surrogate().convex_hull_area;
        cumulative_ch_area += item_ch_area * (*quantity as f32);
        if cumulative_ch_area > cutoff_threshold_area {
            ch_area_cutoff = item_ch_area;
            debug!(
                "[DSRP] cutoff ch area: {}, for item id: {}, bbox: {:?}",
                ch_area_cutoff, item.id, item.shape_cd.bbox
            );
            break;
        }
    }

    // Step 2: Select two 'large' items and 'swap' them.

    let large_items = sep
        .prob
        .layout
        .placed_items
        .iter()
        .filter(|(_, pi)| pi.shape.surrogate().convex_hull_area >= ch_area_cutoff);

    //Choose a first item with a large enough convex hull
    let (pk1, pi1) = large_items
        .clone()
        .choose(&mut sep.rng)
        .expect("[DSRP] failed to choose first item");

    //Choose a second item with a large enough convex hull and different enough from the first.
    //If no such item is found, choose a random one.
    let (pk2, pi2) = large_items.clone()
        .filter(|(_, pi)|
            // Ensure the second item is different from the first
            !approx_eq!(f32, pi.shape.area,pi1.shape.area, epsilon = pi1.shape.area * 0.01) &&
                !approx_eq!(f32, pi.shape.diameter, pi1.shape.diameter, epsilon = pi1.shape.diameter * 0.01)
        )
        .choose(&mut sep.rng)
        .or_else(|| {
            sep.prob.layout.placed_items.iter()
                .filter(|(pk, _)| *pk != pk1) // Ensure the second item is not the same as the first
                .choose(&mut sep.rng)
        }) // As a fallback, choose any item
        .expect("[EXPL] failed to choose second item for disruption");

    // Step 3: Swap the two items' positions in the layout.

    let dt1_old = pi1.d_transf;
    let dt2_old = pi2.d_transf;

    // Make sure the swaps do not violate feasibility (rotation).
    let dt1_new = convert_sample_to_closest_feasible(dt2_old, sep.prob.instance.item(pi1.item_id));
    let dt2_new = convert_sample_to_closest_feasible(dt1_old, sep.prob.instance.item(pi2.item_id));

    info!(
        "[EXPL] disrupting by swapping two large items (id: {} <-> {})",
        pi1.item_id, pi2.item_id
    );

    let pk1 = sep.move_item(pk1, dt1_new);
    let pk2 = sep.move_item(pk2, dt2_new);

    // Step 4: Move all items that are practically contained by one of the swapped items to the "empty space" created by the moved item.
    //         This is particularly important when huge items are swapped with smaller items.
    //         The huge item will create a large empty space and many of the items which previously
    //         surrounded the smaller one will be contained by the huge one.
    {
        // transformation to convert the contained items' position (relative to the old and new positions of the swapped items)
        let converting_transformation = dt1_new.compose().inverse().transform(&dt1_old.compose());

        for c1_pk in practically_contained_items(&sep.prob.layout, pk1)
            .into_iter()
            .filter(|c1_pk| *c1_pk != pk2)
        {
            let c1_pi = &sep.prob.layout.placed_items[c1_pk];

            let new_dt = c1_pi
                .d_transf
                .compose()
                .transform(&converting_transformation)
                .decompose();

            //Ensure the sure the new position is feasible
            let new_feasible_dt =
                convert_sample_to_closest_feasible(new_dt, sep.prob.instance.item(c1_pi.item_id));
            sep.move_item(c1_pk, new_feasible_dt);
        }
    }

    // Do the same for the second item, but using the second transformation
    {
        let converting_transformation = dt2_new.compose().inverse().transform(&dt2_old.compose());

        for c2_pk in practically_contained_items(&sep.prob.layout, pk2)
            .into_iter()
            .filter(|c2_pk| *c2_pk != pk1)
        {
            let c2_pi = &sep.prob.layout.placed_items[c2_pk];
            let new_dt = c2_pi
                .d_transf
                .compose()
                .transform(&converting_transformation)
                .decompose();

            //make sure the new position is feasible
            let new_feasible_dt =
                convert_sample_to_closest_feasible(new_dt, sep.prob.instance.item(c2_pi.item_id));
            sep.move_item(c2_pk, new_feasible_dt);
        }
    }
}

/// Collects all items which point of inaccessibility (POI) is contained by pk_c's shape.
fn practically_contained_items(layout: &Layout, pk_c: PItemKey) -> Vec<PItemKey> {
    let pi_c = &layout.placed_items[pk_c];
    // Detect all collisions with the item pk_c's shape.
    let mut collector = BasicHazardCollector::new();
    layout
        .cde()
        .collect_poly_collisions(&pi_c.shape, &mut collector);

    // Filter out the items that have their POI contained by pk_c's shape.
    collector
        .iter()
        .filter_map(|(_, he)| match he {
            HazardEntity::PlacedItem { pk, .. } => Some(*pk),
            _ => None,
        })
        .filter(|pk| *pk != pk_c) // Ensure we don't include the item itself
        .filter(|pk| {
            // Check if the POI of the item is contained by pk_c's shape
            let poi = layout.placed_items[*pk].shape.poi;
            pi_c.shape.collides_with(&poi.center)
        })
        .collect_vec()
}
