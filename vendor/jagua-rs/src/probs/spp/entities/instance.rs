use crate::entities::InferiorQualityZone;
use crate::entities::{Container, Instance, Item};
use crate::geometry::primitives::{Rect, SPolygon};
use crate::geometry::shape_modification::ShapeModifyMode;
use crate::geometry::{DTransformation, OriginalShape};
use crate::probs::spp::entities::Strip;
use crate::probs::spp::util::assertions;
use anyhow::{Result, ensure};
use std::{iter, sync::Arc};

/// Immutable stock geometry, shared by instances and solution snapshots.
#[derive(Debug, Clone)]
pub struct SPStockConstraints {
    pub max_width: f32,
    pub holes: InferiorQualityZone,
}

#[derive(Debug, Clone)]
/// Instance of the Strip Packing Problem.
pub struct SPInstance {
    /// The items to be packed and their demands
    pub items: Vec<(Item, usize)>,
    /// Construction priorities indexed by item ID.
    pub item_priorities: Vec<i32>,
    /// The strip in which to pack the items
    pub base_strip: Strip,
    pub stock_constraints: Option<Arc<SPStockConstraints>>,
}

#[cfg(test)]
std::thread_local! {
    pub(super) static CONTAINER_BUILDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl SPInstance {
    #[must_use]
    pub fn new(items: Vec<(Item, usize)>, base_strip: Strip) -> Self {
        assert!(
            assertions::instance_item_ids_correct(&items),
            "All items should have consecutive IDs starting from 0"
        );

        Self {
            item_priorities: vec![0; items.len()],
            items,
            base_strip,
            stock_constraints: None,
        }
    }

    /// Attaches quality-0 holes in stock coordinates and prepares their loss surrogates.
    /// Snapshots may only be restored into instances cloned from this constrained instance.
    pub fn with_stock_constraints(mut self, mut constraints: SPStockConstraints) -> Result<Self> {
        ensure!(
            constraints.max_width.is_finite() && constraints.max_width > 0.0,
            "stock maximum width must be finite and positive"
        );
        ensure!(
            self.base_strip.width.is_finite() && self.base_strip.width <= constraints.max_width,
            "base strip exceeds stock maximum width"
        );
        ensure!(
            constraints.holes.quality == 0,
            "stock holes must have quality 0"
        );
        ensure!(
            constraints.holes.shapes_orig.len() == constraints.holes.shapes_cd.len(),
            "stock hole geometry lengths differ"
        );
        for shape in &mut constraints.holes.shapes_cd {
            Arc::make_mut(shape)
                .generate_surrogate(self.base_strip.cde_config.item_surrogate_config)?;
        }
        self.stock_constraints = Some(Arc::new(constraints));
        Ok(self)
    }

    /// Builds a container without moving, clipping or reindexing stock holes.
    #[must_use]
    pub fn container_for_strip(&self, strip: Strip) -> Container {
        #[cfg(test)]
        CONTAINER_BUILDS.with(|count| count.set(count.get() + 1));
        if let Some(stock) = &self.stock_constraints {
            assert!(
                strip.width.is_finite() && strip.width > 0.0 && strip.width <= stock.max_width,
                "strip exceeds stock maximum width"
            );
            Container::new(
                strip.width.to_bits() as usize,
                OriginalShape {
                    shape: SPolygon::from(
                        Rect::try_new(0.0, 0.0, strip.width, strip.fixed_height).unwrap(),
                    ),
                    pre_transform: DTransformation::empty(),
                    modify_mode: ShapeModifyMode::Deflate,
                    modify_config: strip.shape_modify_config,
                },
                vec![stock.holes.clone()],
                strip.cde_config,
            )
            .unwrap()
        } else {
            strip.into()
        }
    }

    pub fn matches_stock_constraints(&self, other: &Option<Arc<SPStockConstraints>>) -> bool {
        match (&self.stock_constraints, other) {
            (None, None) => true,
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    #[allow(clippy::cast_precision_loss)]
    #[must_use]
    pub fn item_area(&self) -> f32 {
        self.items
            .iter()
            .map(|(item, qty)| item.shape_orig.area() * *qty as f32)
            .sum()
    }

    #[must_use]
    pub fn item_qty(&self, id: usize) -> usize {
        self.items[id].1
    }

    #[must_use]
    pub fn total_item_qty(&self) -> usize {
        self.items.iter().map(|(_, qty)| *qty).sum()
    }
}

impl Instance for SPInstance {
    fn items(&self) -> impl Iterator<Item = &Item> {
        self.items.iter().map(|(item, _qty)| item)
    }

    fn containers(&self) -> impl Iterator<Item = &Container> {
        iter::empty()
    }

    fn item(&self, id: usize) -> &Item {
        &self.items.get(id).unwrap().0
    }

    fn container(&self, _id: usize) -> &Container {
        panic!("no predefined containers for strip packing instances")
    }
}
