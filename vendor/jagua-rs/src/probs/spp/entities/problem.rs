use crate::Instant;
use crate::entities::{Instance, Layout, PItemKey};
use crate::geometry::DTransformation;
use crate::probs::spp::entities::strip::Strip;
use crate::probs::spp::entities::{SPInstance, SPSolution};
use crate::probs::spp::util::assertions::problem_matches_solution;
use itertools::Itertools;

/// Modifiable counterpart of [`SPInstance`]: items can be placed and removed, strip can be extended or fitted.
#[derive(Clone)]
pub struct SPProblem {
    pub instance: SPInstance,
    pub strip: Strip,
    pub layout: Layout,
    pub item_demand_qtys: Vec<usize>,
}

impl SPProblem {
    #[must_use]
    pub fn new(instance: SPInstance) -> Self {
        let item_demand_qtys = instance.items.iter().map(|(_, qty)| *qty).collect_vec();
        let strip = instance.base_strip;
        let layout = Layout::new(instance.container_for_strip(strip));

        Self {
            instance,
            strip,
            layout,
            item_demand_qtys,
        }
    }

    /// Modifies the width of the strip in the back, keeping the front fixed.
    pub fn change_strip_width(&mut self, new_width: f32) {
        let mut strip = self.strip;
        strip.set_width(new_width);
        let container = self.instance.container_for_strip(strip);
        self.layout.swap_container(container);
        self.strip = strip;
    }

    /// Shrinks the strip to the minimum width that fits all items.
    pub fn fit_strip(&mut self) {
        let feasible_before = self.layout.is_feasible();

        //Find the rightmost item in the strip and add some tolerance (avoiding false collision positives)
        let item_x_max = self
            .layout
            .placed_items
            .values()
            .map(|pi| pi.shape.bbox.x_max)
            .max_by(|a, b| a.partial_cmp(b).unwrap())
            .unwrap()
            * 1.00001;

        // add the shape offset if any, the strip needs to be at least `offset` wider than the items
        let fitted_width = item_x_max + self.strip.shape_modify_config.offset.unwrap_or(0.0);

        let fitted_width = self
            .instance
            .stock_constraints
            .as_ref()
            .map_or(fitted_width, |stock| fitted_width.min(stock.max_width));
        self.change_strip_width(fitted_width);
        debug_assert_eq!(feasible_before, self.layout.is_feasible());
    }

    /// Places an item according to the given `SPPlacement` in the problem.
    pub fn place_item(&mut self, placement: SPPlacement) -> PItemKey {
        self.register_included_item(placement.item_id);
        let item = self.instance.item(placement.item_id);

        self.layout.place_item(item, placement.d_transf)
    }

    /// Removes a placed item from the strip. Returns the placement of the item.
    pub fn remove_item(&mut self, pkey: PItemKey) -> SPPlacement {
        let pi = self.layout.remove_item(pkey);
        self.deregister_included_item(pi.item_id);

        SPPlacement {
            item_id: pi.item_id,
            d_transf: pi.d_transf,
        }
    }

    /// Creates a snapshot of the current state of the problem as a [`SPSolution`].
    #[must_use]
    pub fn save(&self) -> SPSolution {
        let solution = SPSolution {
            stock_constraints: self.instance.stock_constraints.clone(),
            layout_snapshot: self.layout.save(),
            strip: self.strip,
            time_stamp: Instant::now(),
        };

        debug_assert!(problem_matches_solution(self, &solution));

        solution
    }

    /// Restores the state of the problem to the given [`SPSolution`].
    pub fn restore(&mut self, solution: &SPSolution) {
        assert!(
            self.instance
                .matches_stock_constraints(&solution.stock_constraints),
            "solution stock constraints do not match instance"
        );
        if self.strip == solution.strip {
            // the strip is the same, restore the layout
            self.layout.restore(&solution.layout_snapshot);
        } else {
            // the strip has changed, rebuild the layout
            let container = self.instance.container_for_strip(solution.strip);
            self.layout = Layout::new(container);
            self.layout.restore(&solution.layout_snapshot);
            self.strip = solution.strip;
        }

        //Restore the item demands
        {
            self.item_demand_qtys
                .iter_mut()
                .enumerate()
                .for_each(|(id, qty)| *qty = self.instance.item_qty(id));

            self.layout
                .placed_items
                .iter()
                .for_each(|(_, pi)| self.item_demand_qtys[pi.item_id] -= 1);
        }
        debug_assert!(problem_matches_solution(self, solution));
    }

    fn register_included_item(&mut self, item_id: usize) {
        self.item_demand_qtys[item_id] -= 1;
    }

    fn deregister_included_item(&mut self, item_id: usize) {
        self.item_demand_qtys[item_id] += 1;
    }

    #[must_use]
    pub fn density(&self) -> f32 {
        self.layout.density(&self.instance)
    }

    #[must_use]
    pub fn strip_width(&self) -> f32 {
        self.strip.width
    }

    #[must_use]
    pub fn n_placed_items(&self) -> usize {
        self.layout.placed_items.len()
    }
}

/// Represents a placement of an item in the strip packing problem.
#[derive(Debug, Clone, Copy)]
pub struct SPPlacement {
    pub item_id: usize,
    pub d_transf: DTransformation,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collision_detection::CDEConfig;
    use crate::geometry::shape_modification::ShapeModifyConfig;
    use crate::probs::spp::entities::instance::CONTAINER_BUILDS;

    #[test]
    fn restore_same_strip_does_not_build_container() {
        let strip = Strip::new(100.0, CDEConfig {
            quadtree_depth: 4,
            cd_threshold: 16,
            item_surrogate_config: crate::geometry::fail_fast::SPSurrogateConfig::none(),
        }, ShapeModifyConfig::default(), 100.0).unwrap();
        let mut problem = SPProblem::new(SPInstance::new(vec![], strip));
        let solution = problem.save();
        CONTAINER_BUILDS.with(|count| count.set(0));
        for _ in 0..3 {
            problem.restore(&solution);
        }
        CONTAINER_BUILDS.with(|count| assert_eq!(count.get(), 0));
        problem.change_strip_width(90.0);
        CONTAINER_BUILDS.with(|count| count.set(0));
        problem.restore(&solution);
        CONTAINER_BUILDS.with(|count| assert_eq!(count.get(), 1));
        assert_eq!(problem.strip, solution.strip);
    }
}
