use geo::{Area, BooleanOps, Contains, Intersects, LineString, MultiPolygon, Polygon, TriangulateEarcut, Validation};
use jagua_rs::entities::InferiorQualityZone;
use jagua_rs::geometry::{DTransformation, OriginalShape};
use jagua_rs::geometry::primitives::{Point, SPolygon};
use jagua_rs::geometry::shape_modification::{ShapeModifyConfig, ShapeModifyMode};
use jagua_rs::probs::spp::entities::{SPInstance, SPStockConstraints};
use serde::Deserialize;

#[derive(Deserialize)]
struct StockInput {
    #[serde(default)]
    stock_geometry: Option<StockGeometry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StockGeometry {
    outer: Vec<[f32; 2]>,
    #[serde(default)]
    holes: Vec<Vec<[f32; 2]>>,
}

pub(crate) fn parse(input: &str, height: f32) -> Result<Option<SPStockConstraints>, String> {
    let input: StockInput = serde_json::from_str(input).map_err(|e| e.to_string())?;
    input.stock_geometry.map(|stock| stock.constraints(height)).transpose()
}

pub(crate) fn apply(mut instance: SPInstance, constraints: Option<SPStockConstraints>) -> Result<SPInstance, String> {
    match constraints {
        Some(constraints) => {
            if instance.base_strip.shape_modify_config.offset.is_some_and(|offset|
                constraints.max_width <= 2.0 * offset || instance.base_strip.fixed_height <= 2.0 * offset) {
                return Err("Stock dimensions must exceed clearance".into());
            }
            // The imported area-based strip can be narrower than twice its edge
            // offset. Start finite stock at its full width before constructing it.
            instance.base_strip.set_width(constraints.max_width);
            instance.with_stock_constraints(constraints).map_err(|e| e.to_string())
        },
        None => Ok(instance),
    }
}

impl StockGeometry {
    fn constraints(self, height: f32) -> Result<SPStockConstraints, String> {
        if !height.is_finite() || height <= 0.0 || height > 100_000.0
            || self.holes.len() > 500
            || self.outer.len() + self.holes.iter().map(Vec::len).sum::<usize>() > 10_000 {
            return Err("Invalid stock dimensions or geometry size".into());
        }
        let outer = ring(self.outer, height)?;
        let max_width = outer.exterior().0.iter().map(|p| p.x as f32).fold(0.0, f32::max);
        if max_width <= 0.0 {
            return Err("Stock width must be positive".into());
        }
        let bounds = Polygon::new(LineString::from(vec![
            (0.0, 0.0), (f64::from(max_width), 0.0),
            (f64::from(max_width), f64::from(height)), (0.0, f64::from(height)),
        ]), vec![]);
        let mut forbidden = bounds.difference(&outer);
        for points in self.holes {
            let hole = ring(points, height)?;
            if !outer.contains(&hole) || outer.exterior().intersects(hole.exterior()) {
                return Err("Stock holes must be strictly inside the outer ring".into());
            }
            forbidden = forbidden.union(&MultiPolygon(vec![hole]));
        }
        let mut shapes = Vec::new();
        for polygon in forbidden.0 {
            if polygon.interiors().is_empty() {
                shapes.push(original(polygon.exterior())?);
            } else {
                let triangles = polygon.earcut_triangles();
                let area: f64 = triangles.iter().map(Area::unsigned_area).sum();
                if (area - polygon.unsigned_area()).abs() > 1e-8 * polygon.unsigned_area().max(1.0) {
                    return Err("Stock forbidden-region triangulation lost area".into());
                }
                for triangle in triangles {
                    shapes.push(original(&LineString::from(vec![triangle.v1(), triangle.v2(), triangle.v3()]))?);
                }
            }
        }
        Ok(SPStockConstraints {
            max_width,
            holes: InferiorQualityZone::new(0, shapes).map_err(|e| e.to_string())?,
        })
    }
}

fn ring(mut points: Vec<[f32; 2]>, height: f32) -> Result<Polygon<f64>, String> {
    if points.len() > 1 && points.first() == points.last() {
        points.pop();
    }
    if !(3..=4096).contains(&points.len()) || points.iter().any(|p|
        !p[0].is_finite() || !p[1].is_finite()
            || p[0] < 0.0 || p[0] > 100_000.0 || p[1] < 0.0 || p[1] > height) {
        return Err("Stock rings require 3..4096 finite vertices within material bounds".into());
    }
    let polygon = Polygon::new(LineString::from(points.into_iter()
        .map(|p| (f64::from(p[0]), f64::from(p[1]))).collect::<Vec<_>>()), vec![]);
    if !polygon.is_valid() || polygon.unsigned_area() <= 0.0
        || polygon.exterior().0.windows(2).any(|p| p[0] == p[1]) {
        return Err("Stock rings must be simple nondegenerate polygons".into());
    }
    Ok(polygon)
}

fn original(ring: &LineString<f64>) -> Result<OriginalShape, String> {
    let mut points: Vec<_> = ring.0.iter().map(|p| Point(p.x as f32, p.y as f32)).collect();
    if points.first() == points.last() {
        points.pop();
    }
    Ok(OriginalShape {
        shape: SPolygon::new(points).map_err(|e| format!("Invalid stock forbidden polygon: {e}"))?,
        pre_transform: DTransformation::empty(),
        modify_mode: ShapeModifyMode::Inflate,
        // Parts already receive the solver's half-clearance offset. Never offset
        // decomposed stock polygons: that would also inflate their shared edges.
        modify_config: ShapeModifyConfig::default(),
    })
}
