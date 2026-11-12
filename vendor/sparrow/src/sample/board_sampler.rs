use jagua_rs::entities::Item;
use jagua_rs::geometry::geo_enums::RotationRange;
use jagua_rs::geometry::geo_traits::{CollidesWith, DistanceTo, TransformableFrom};
use jagua_rs::geometry::primitives::{Edge, Point, Rect, SPolygon};
use jagua_rs::geometry::{DTransformation, Transformation};
use jagua_rs::probs::spp::entities::SPBoardDomain;
use rand::prelude::IndexedRandom;
use rand::{Rng, RngExt};
use std::f32::consts::TAU;

const ROTATIONS: usize = 16;
const REJECTION_LIMIT: usize = 8;

struct Entry {
    board: usize,
    rotation: f32,
    rotated_bbox: Rect,
    x: (f32, f32),
    y: (f32, f32),
}

/// Sampling hints only: failed attempts fall back to the original sampler.
/// Does not constrain collision-loss moves or coordinate descent.
pub struct BoardSampler {
    entries: Vec<Entry>,
    rectangular: Vec<bool>,
    shape_buffer: SPolygon,
}

impl BoardSampler {
    pub fn new(
        boards: &[SPBoardDomain],
        item: &Item,
        sample_bbox: Rect,
        container_bbox: Rect,
    ) -> Option<Self> {
        if boards.is_empty() {
            return None;
        }
        let rotations = match &item.allowed_rotation {
            RotationRange::None => vec![0.0],
            RotationRange::Discrete(rotations) => rotations.clone(),
            RotationRange::Continuous => (0..ROTATIONS)
                .map(|i| i as f32 * TAU / ROTATIONS as f32)
                .collect(),
        };
        let mut shape_buffer = item.shape_cd.as_ref().clone();
        let mut entries = Vec::new();
        for rotation in rotations {
            let bbox = shape_buffer
                .transform_from(&item.shape_cd, &Transformation::from_rotation(rotation))
                .bbox;
            for (board, domain) in boards.iter().enumerate() {
                let outer = domain.outer.bbox;
                let x = (
                    (outer.x_min.max(container_bbox.x_min) - bbox.x_min).max(sample_bbox.x_min),
                    (outer.x_max.min(container_bbox.x_max) - bbox.x_max).min(sample_bbox.x_max),
                );
                let y = (
                    (outer.y_min.max(container_bbox.y_min) - bbox.y_min).max(sample_bbox.y_min),
                    (outer.y_max.min(container_bbox.y_max) - bbox.y_max).min(sample_bbox.y_max),
                );
                if [x.0, x.1, y.0, y.1].iter().all(|v| v.is_finite()) && x.0 <= x.1 && y.0 <= y.1 {
                    entries.push(Entry {
                        board,
                        rotation,
                        rotated_bbox: bbox,
                        x,
                        y,
                    });
                }
            }
        }
        let rectangular = boards
            .iter()
            .map(|board| {
                let bbox = board.outer.bbox;
                board.outer.vertices.len() == 4
                    && board.outer.vertices.iter().all(|point| {
                        (point.0 == bbox.x_min || point.0 == bbox.x_max)
                            && (point.1 == bbox.y_min || point.1 == bbox.y_max)
                    })
            })
            .collect();
        (!entries.is_empty()).then_some(Self {
            entries,
            rectangular,
            shape_buffer,
        })
    }

    pub fn sample(
        &mut self,
        boards: &[SPBoardDomain],
        item: &Item,
        rng: &mut impl Rng,
    ) -> Option<DTransformation> {
        for _ in 0..REJECTION_LIMIT {
            let entry = self.entries.choose(rng)?;
            let dt = DTransformation::new(entry.rotation, (axis(entry.x, rng), axis(entry.y, rng)));
            self.shape_buffer.transform_from(&item.shape_cd, &dt.into());
            if contains_shape(
                &boards[entry.board],
                &self.shape_buffer,
                self.rectangular[entry.board],
            ) {
                return Some(dt);
            }
        }
        None
    }

    pub fn sample_edge(
        &mut self,
        boards: &[SPBoardDomain],
        item: &Item,
        anchors: &[Rect],
        rng: &mut impl Rng,
    ) -> Option<DTransformation> {
        for _ in 0..REJECTION_LIMIT {
            let entry = self.entries.choose(rng)?;
            let mut x = axis(entry.x, rng);
            let mut y = axis(entry.y, rng);
            let slack_x = entry.x.0.abs().max(entry.x.1.abs()).max(1.0) * f32::EPSILON * 4.0;
            let slack_y = entry.y.0.abs().max(entry.y.1.abs()).max(1.0) * f32::EPSILON * 4.0;
            match rng.random_range(0..6) {
                0 => x = (entry.x.0 + slack_x).min(entry.x.1),
                1 => x = (entry.x.1 - slack_x).max(entry.x.0),
                2 => y = (entry.y.0 + slack_y).min(entry.y.1),
                3 => y = (entry.y.1 - slack_y).max(entry.y.0),
                direction => {
                    let Some(anchor) = anchors.choose(rng) else {
                        continue;
                    };
                    if direction == 4 {
                        x = if rng.random_range(0..2) == 0 {
                            anchor.x_max - entry.rotated_bbox.x_min + slack_x
                        } else {
                            anchor.x_min - entry.rotated_bbox.x_max - slack_x
                        };
                    } else {
                        y = if rng.random_range(0..2) == 0 {
                            anchor.y_max - entry.rotated_bbox.y_min + slack_y
                        } else {
                            anchor.y_min - entry.rotated_bbox.y_max - slack_y
                        };
                    }
                }
            }
            if x < entry.x.0 || x > entry.x.1 || y < entry.y.0 || y > entry.y.1 {
                continue;
            }
            let dt = DTransformation::new(entry.rotation, (x, y));
            self.shape_buffer.transform_from(&item.shape_cd, &dt.into());
            if contains_shape(
                &boards[entry.board],
                &self.shape_buffer,
                self.rectangular[entry.board],
            ) {
                return Some(dt);
            }
        }
        None
    }
}

fn axis((start, end): (f32, f32), rng: &mut impl Rng) -> f32 {
    if start == end {
        start
    } else {
        rng.random_range(start..end)
    }
}

fn inside_or_boundary(polygon: &SPolygon, point: &Point) -> bool {
    polygon.collides_with(point)
        || polygon
            .edge_iter()
            .any(|edge| edge.sq_distance_to(point) == 0.0)
}

fn interior(polygon: &SPolygon, point: &Point) -> bool {
    polygon.collides_with(point)
        && !polygon
            .edge_iter()
            .any(|edge| edge.sq_distance_to(point) == 0.0)
}

// Split at boundary intersections: checking vertices alone misses concave notches.
fn edge_stays_inside(edge: Edge, polygon: &SPolygon) -> bool {
    let dx = edge.end.0 - edge.start.0;
    let dy = edge.end.1 - edge.start.1;
    let mut cuts = vec![0.0, 1.0];
    for boundary in polygon.edge_iter() {
        if let Some(point) = edge.collides_at(&boundary) {
            let t = if dx.abs() >= dy.abs() {
                (point.0 - edge.start.0) / dx
            } else {
                (point.1 - edge.start.1) / dy
            };
            if t.is_finite() && t > 0.0 && t < 1.0 {
                cuts.push(t);
            }
        }
    }
    cuts.sort_by(f32::total_cmp);
    cuts.windows(2).all(|pair| {
        let t = (pair[0] + pair[1]) * 0.5;
        inside_or_boundary(
            polygon,
            &Point(edge.start.0 + t * dx, edge.start.1 + t * dy),
        )
    })
}

/// Exact physical-domain check; never trusts the rectangular fast-path hint.
pub(crate) fn contains_in_board(board: &SPBoardDomain, shape: &SPolygon) -> bool {
    contains_shape(board, shape, false)
}

fn contains_shape(board: &SPBoardDomain, shape: &SPolygon, rectangular: bool) -> bool {
    if rectangular {
        let outer = board.outer.bbox;
        if shape.bbox.x_min < outer.x_min
            || shape.bbox.x_max > outer.x_max
            || shape.bbox.y_min < outer.y_min
            || shape.bbox.y_max > outer.y_max
        {
            return false;
        }
    } else if !shape
        .vertices
        .iter()
        .all(|p| inside_or_boundary(&board.outer, p))
        || !shape
            .edge_iter()
            .all(|edge| edge_stays_inside(edge, &board.outer))
    {
        return false;
    }
    for hole in &board.holes {
        if !shape.bbox.collides_with(&hole.bbox) {
            continue;
        }
        if shape.vertices.iter().any(|p| interior(hole, p))
            || hole.vertices.iter().any(|p| interior(shape, p))
            || shape.edge_iter().any(|edge| {
                hole.edge_iter()
                    .any(|boundary| edge.collides_with(&boundary))
            })
        {
            return false;
        }
    }
    true
}
