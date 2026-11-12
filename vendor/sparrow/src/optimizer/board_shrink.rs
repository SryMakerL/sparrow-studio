use jagua_rs::geometry::primitives::Rect;
use jagua_rs::probs::spp::entities::SPProblem;

/// A local step scale for fixed, disconnected board domains.
pub struct BoardShrink {
    boards: Vec<Rect>,
    factor: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct BoardShrinkStep {
    pub next_width: f32,
    pub split_min: f32,
    pub split_max: f32,
}

impl BoardShrink {
    pub fn new(prob: &SPProblem) -> Option<Self> {
        let stock = prob.instance.stock_constraints.as_ref()?;
        if stock.boards.len() < 2 {
            return None;
        }
        Some(Self {
            boards: stock.boards.iter().map(|board| board.outer.bbox).collect(),
            factor: 1.0,
        })
    }

    pub fn step(&self, prob: &SPProblem, fraction: f32) -> Option<BoardShrinkStep> {
        let width = prob.strip_width();
        let board = self
            .boards
            .iter()
            .filter(|board| board.x_min < width)
            .max_by(|a, b| a.x_min.total_cmp(&b.x_min))?;
        let inset = width - prob.layout.container.outer_cd.bbox.width();
        let rightmost = prob
            .layout
            .placed_items
            .values()
            .map(|item| item.shape.bbox.x_max)
            .fold(0.0, f32::max);
        let slack = (width - rightmost - inset).max(0.0);
        let local_cap = (board.width() * 0.02).max(slack.min(board.width() * 0.1));
        let minimum = width.abs().max(1.0) * f32::EPSILON * 2.0;
        let amount = (width * fraction).min(local_cap) * self.factor;
        if !amount.is_finite() || amount < minimum {
            return None;
        }
        let next_width = width - amount;
        if next_width >= width || next_width <= 0.0 {
            return None;
        }
        Some(BoardShrinkStep {
            next_width,
            split_min: board.x_min.max(0.0),
            split_max: width.min(board.x_max),
        })
    }

    pub fn failed(&mut self) {
        self.factor *= 0.5;
    }

    pub fn succeeded(&mut self) {
        self.factor = (self.factor * 1.25).min(1.0);
    }
}
