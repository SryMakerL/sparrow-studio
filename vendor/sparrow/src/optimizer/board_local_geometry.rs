use jagua_rs::collision_detection::CDEConfig;
use jagua_rs::entities::{Container, InferiorQualityZone};
use jagua_rs::geometry::primitives::{Point, Rect, SPolygon};
use jagua_rs::geometry::shape_modification::{ShapeModifyConfig, ShapeModifyMode};
use jagua_rs::geometry::{DTransformation, OriginalShape};
use std::sync::Arc;

type Vertex = (f64, f64);

/// Clip prepared fixed hazards, never the already-offset item shapes. Concave
/// polygons are triangulated before clipping so disconnected intersections do
/// not acquire artificial connecting edges. All arithmetic precedes f32 casts.
pub(super) fn local_hazards(
    container: &Container,
    clip: Rect,
    translation: (f32, f32),
    config: CDEConfig,
) -> Option<InferiorQualityZone> {
    let mut zone = InferiorQualityZone {
        quality: 0,
        shapes_orig: Vec::new(),
        shapes_cd: Vec::new(),
    };
    if let Some(holes) = &container.quality_zones[0] {
        for shape in &holes.shapes_cd {
            if shape.bbox.x_min >= clip.x_max
                || shape.bbox.x_max <= clip.x_min
                || shape.bbox.y_min >= clip.y_max
                || shape.bbox.y_max <= clip.y_min
            {
                continue;
            }
            let vertices: Vec<_> = shape
                .vertices
                .iter()
                .map(|p| (f64::from(p.0), f64::from(p.1)))
                .collect();
            for polygon in convex_parts(vertices)? {
                let mut polygon = polygon;
                for (axis, bound, above) in [
                    (0, f64::from(clip.x_min), true),
                    (0, f64::from(clip.x_max), false),
                    (1, f64::from(clip.y_min), true),
                    (1, f64::from(clip.y_max), false),
                ] {
                    polygon = clip_half_plane(&polygon, axis, bound, above);
                }
                let points: Vec<_> = polygon
                    .into_iter()
                    .map(|(x, y)| {
                        Point(
                            (x + f64::from(translation.0)) as f32,
                            (y + f64::from(translation.1)) as f32,
                        )
                    })
                    .collect();
                push_shape(&mut zone, points, config)?;
            }
        }
    }
    Some(zone)
}

pub(super) fn add_walls(
    zone: &mut InferiorQualityZone,
    allowed: Rect,
    translation: (f32, f32),
    width: f32,
    height: f32,
    config: CDEConfig,
) -> Option<()> {
    // Unlike an existing complement hazard, a synthetic wall must not turn
    // a feasible exact contact (e.g. two touching boards) into a collision.
    // The original global hazards/inset and final board containment still
    // decide feasibility; this slack only absorbs f32 translation rounding.
    let epsilon = width.max(height).max(1.0) * f32::EPSILON * 4.0;
    let xmin = (allowed.x_min + translation.0 - epsilon).max(0.0);
    let xmax = (allowed.x_max + translation.0 + epsilon).min(width);
    let ymin = (allowed.y_min + translation.1 - epsilon).max(0.0);
    let ymax = (allowed.y_max + translation.1 + epsilon).min(height);
    for (x0, y0, x1, y1) in [
        (0.0, 0.0, xmin, height),
        (xmax, 0.0, width, height),
        (xmin, 0.0, xmax, ymin),
        (xmin, ymax, xmax, height),
    ] {
        if x1 > x0 && y1 > y0 {
            push_shape(
                zone,
                vec![Point(x0, y0), Point(x1, y0), Point(x1, y1), Point(x0, y1)],
                config,
            )?;
        }
    }
    Some(())
}

fn push_shape(
    zone: &mut InferiorQualityZone,
    mut points: Vec<Point>,
    config: CDEConfig,
) -> Option<()> {
    points.dedup();
    if points.len() > 1 && points.first() == points.last() {
        points.pop();
    }
    if points.len() < 3 || SPolygon::calculate_area(&points) == 0.0 {
        return Some(());
    }
    let bbox = SPolygon::generate_bounding_box(&points);
    if bbox.width() == 0.0 || bbox.height() == 0.0 {
        return Some(());
    }
    let sx = (bbox.width() / (bbox.height() * 32.0)).max(1.0);
    let sy = (bbox.height() / (bbox.width() * 32.0)).max(1.0);
    let normalized = points
        .iter()
        .map(|p| Point((p.0 - bbox.x_min) / sx, (p.1 - bbox.y_min) / sy))
        .collect();
    let mut shape = SPolygon::new(normalized).ok()?;
    // Very thin clipped walls need a certified loss pole, not dozens of pole
    // searches that can consume the complete local deadline during setup.
    let mut surrogate_config = config.item_surrogate_config;
    surrogate_config.n_pole_limits = [(1, 0.0); 3];
    surrogate_config.n_ff_piers = 0;
    shape.generate_surrogate(surrogate_config).ok()?;
    shape.poi.center.0 = shape.poi.center.0 * sx + bbox.x_min;
    shape.poi.center.1 = shape.poi.center.1 * sy + bbox.y_min;
    if let Some(surrogate) = &mut shape.surrogate {
        for pole in &mut surrogate.poles {
            pole.center.0 = pole.center.0 * sx + bbox.x_min;
            pole.center.1 = pole.center.1 * sy + bbox.y_min;
        }
        for pier in &mut surrogate.piers {
            pier.start.0 = pier.start.0 * sx + bbox.x_min;
            pier.start.1 = pier.start.1 * sy + bbox.y_min;
            pier.end.0 = pier.end.0 * sx + bbox.x_min;
            pier.end.1 = pier.end.1 * sy + bbox.y_min;
        }
        surrogate.convex_hull_area *= sx * sy;
    }
    if SPolygon::calculate_area(&points) < 0.0 {
        points.reverse();
    }
    shape.vertices = points;
    shape.bbox = bbox;
    shape.area = SPolygon::calculate_area(&shape.vertices).abs();
    shape.diameter = SPolygon::calculate_diameter(shape.vertices.clone());
    zone.shapes_orig.push(Arc::new(OriginalShape {
        shape: shape.clone(),
        pre_transform: DTransformation::empty(),
        modify_mode: ShapeModifyMode::Inflate,
        modify_config: ShapeModifyConfig::default(),
    }));
    zone.shapes_cd.push(Arc::new(shape));
    Some(())
}

fn cross(a: Vertex, b: Vertex, c: Vertex) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

fn convex_parts(mut polygon: Vec<Vertex>) -> Option<Vec<Vec<Vertex>>> {
    if polygon.len() < 3 {
        return Some(Vec::new());
    }
    let area: f64 = polygon
        .iter()
        .zip(polygon.iter().cycle().skip(1))
        .map(|(a, b)| (a.0 - b.0) * (a.1 + b.1))
        .sum();
    if area < 0.0 {
        polygon.reverse();
    }
    if (0..polygon.len()).all(|i| {
        cross(
            polygon[i],
            polygon[(i + 1) % polygon.len()],
            polygon[(i + 2) % polygon.len()],
        ) >= 0.0
    }) {
        return Some(vec![polygon]);
    }
    let mut triangles = Vec::new();
    while polygon.len() > 3 {
        let n = polygon.len();
        let ear = (0..n).find(|&i| {
            let a = polygon[(i + n - 1) % n];
            let b = polygon[i];
            let c = polygon[(i + 1) % n];
            cross(a, b, c) > 0.0
                && !(0..n).any(|j| {
                    j != i
                        && j != (i + n - 1) % n
                        && j != (i + 1) % n
                        && cross(a, b, polygon[j]) >= 0.0
                        && cross(b, c, polygon[j]) >= 0.0
                        && cross(c, a, polygon[j]) >= 0.0
                })
        })?;
        triangles.push(vec![
            polygon[(ear + n - 1) % n],
            polygon[ear],
            polygon[(ear + 1) % n],
        ]);
        polygon.remove(ear);
    }
    triangles.push(polygon);
    Some(triangles)
}

fn clip_half_plane(polygon: &[Vertex], axis: usize, bound: f64, above: bool) -> Vec<Vertex> {
    let mut result = Vec::new();
    let value = |p: Vertex| if axis == 0 { p.0 } else { p.1 };
    let inside = |p: Vertex| {
        if above {
            value(p) >= bound
        } else {
            value(p) <= bound
        }
    };
    if polygon.is_empty() {
        return result;
    }
    let mut previous = *polygon.last().unwrap();
    for &current in polygon {
        if inside(previous) != inside(current) {
            let t = (bound - value(previous)) / (value(current) - value(previous));
            let p = (
                previous.0 + t * (current.0 - previous.0),
                previous.1 + t * (current.1 - previous.1),
            );
            result.push(if axis == 0 {
                (bound, p.1)
            } else {
                (p.0, bound)
            });
        }
        if inside(current) {
            result.push(current);
        }
        previous = current;
    }
    result
}
