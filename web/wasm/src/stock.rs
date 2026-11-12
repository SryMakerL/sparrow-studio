use geo::{
    Area, BooleanOps, Contains, Intersects, LineString, MultiPolygon, Polygon, TriangulateEarcut,
    Validation,
};
use jagua_rs::entities::InferiorQualityZone;
use jagua_rs::geometry::primitives::{Point, SPolygon};
use jagua_rs::geometry::shape_modification::{ShapeModifyConfig, ShapeModifyMode};
use jagua_rs::geometry::{DTransformation, OriginalShape};
use jagua_rs::probs::spp::entities::{SPBoardDomain, SPInstance, SPStockConstraints};
use serde::Deserialize;

#[derive(Deserialize)]
struct StockInput {
    #[serde(default)]
    stock_geometry: Option<StockGeometry>,
}

const MAX_BOARD_DIMENSION: f32 = 100_000.0;
const MAX_VIRTUAL_WIDTH: f32 = 10_000_000.0;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StockGeometry {
    outer: Vec<[f32; 2]>,
    #[serde(default)]
    holes: Vec<Vec<[f32; 2]>>,
    #[serde(default)]
    boards: Option<Vec<StockBoard>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StockBoard {
    outer: Vec<[f32; 2]>,
    #[serde(default)]
    holes: Vec<Vec<[f32; 2]>>,
}

pub(crate) fn parse(input: &str, height: f32) -> Result<Option<SPStockConstraints>, String> {
    let input: StockInput = serde_json::from_str(input).map_err(|e| e.to_string())?;
    input
        .stock_geometry
        .map(|stock| stock.constraints(height))
        .transpose()
}

pub(crate) fn apply(
    mut instance: SPInstance,
    constraints: Option<SPStockConstraints>,
) -> Result<SPInstance, String> {
    match constraints {
        Some(mut constraints) => {
            for shape in &mut constraints.holes.shapes_cd {
                if shape.bbox.x_min > MAX_BOARD_DIMENSION
                    || shape.bbox.width() > MAX_BOARD_DIMENSION
                    || shape.bbox.width() > shape.bbox.height() * 32.0
                    || shape.bbox.height() > shape.bbox.width() * 32.0
                {
                    *std::sync::Arc::make_mut(shape) = stock_shape(
                        shape.vertices.clone(),
                        Some(instance.base_strip.cde_config.item_surrogate_config),
                    )?;
                }
            }
            if instance
                .base_strip
                .shape_modify_config
                .offset
                .is_some_and(|offset| {
                    constraints.max_width <= 2.0 * offset
                        || instance.base_strip.fixed_height <= 2.0 * offset
                })
            {
                return Err("Stock dimensions must exceed clearance".into());
            }
            // The imported area-based strip can be narrower than twice its edge
            // offset. Start finite stock at its full width before constructing it.
            instance.base_strip.set_width(constraints.max_width);
            instance
                .with_stock_constraints(constraints)
                .map_err(|e| e.to_string())
        }
        None => Ok(instance),
    }
}

impl StockGeometry {
    fn constraints(self, height: f32) -> Result<SPStockConstraints, String> {
        if !height.is_finite()
            || height <= 0.0
            || height > MAX_BOARD_DIMENSION
            || self.holes.len() > 500
        {
            return Err("Invalid stock dimensions or geometry size".into());
        }
        let max_x = if self.boards.is_some() {
            MAX_VIRTUAL_WIDTH
        } else {
            MAX_BOARD_DIMENSION
        };
        let outer = ring(self.outer, height, max_x)?;
        let max_width = outer
            .exterior()
            .0
            .iter()
            .map(|p| p.x as f32)
            .fold(0.0, f32::max);
        if max_width <= 0.0 {
            return Err("Stock width must be positive".into());
        }
        let bounds = Polygon::new(
            LineString::from(vec![
                (0.0, 0.0),
                (f64::from(max_width), 0.0),
                (f64::from(max_width), f64::from(height)),
                (0.0, f64::from(height)),
            ]),
            vec![],
        );
        let mut domains = Vec::new();
        let forbidden = match self.boards {
            Some(boards) => {
                if boards.is_empty() {
                    return Err("Stock boards must not be empty".into());
                }
                if !self.holes.is_empty() {
                    return Err("Stock boards require empty top-level holes".into());
                }
                if bounds.difference(&outer).unsigned_area() != 0.0 {
                    return Err(
                        "Stock boards require a rectangular outer ring matching material bounds"
                            .into(),
                    );
                }
                let mut outlines: Vec<Polygon<f64>> = Vec::new();
                let mut material = MultiPolygon(vec![]);
                for board in boards {
                    let board_outer = ring(board.outer, height, max_width)?;
                    let min_x = board_outer
                        .exterior()
                        .0
                        .iter()
                        .map(|p| p.x)
                        .fold(f64::INFINITY, f64::min);
                    let board_max_x = board_outer
                        .exterior()
                        .0
                        .iter()
                        .map(|p| p.x)
                        .fold(0.0, f64::max);
                    if board_max_x - min_x > f64::from(MAX_BOARD_DIMENSION) {
                        return Err("Stock board width exceeds physical material limit".into());
                    }
                    if outlines
                        .iter()
                        .any(|other| other.intersection(&board_outer).unsigned_area() > 0.0)
                    {
                        return Err("Stock board outer regions must not overlap".into());
                    }
                    let domain_holes = board
                        .holes
                        .iter()
                        .map(|points| {
                            let polygon = ring(points.clone(), height, max_width)?;
                            original(polygon.exterior()).map(|shape| shape.shape)
                        })
                        .collect::<Result<Vec<_>, String>>()?;
                    let board_holes = holes(&board_outer, board.holes, height, max_width)?;
                    domains.push(SPBoardDomain {
                        outer: original(board_outer.exterior())?.shape,
                        holes: domain_holes,
                    });
                    let allowed = MultiPolygon(vec![board_outer.clone()]).difference(&board_holes);
                    material = material.union(&allowed);
                    outlines.push(board_outer);
                }
                bounds.difference(&material)
            }
            None => bounds
                .difference(&outer)
                .union(&holes(&outer, self.holes, height, max_x)?),
        };
        let mut shapes = Vec::new();
        for polygon in forbidden.0 {
            if polygon.interiors().is_empty() {
                shapes.push(original(polygon.exterior())?);
            } else {
                let triangles = polygon.earcut_triangles();
                let area: f64 = triangles.iter().map(Area::unsigned_area).sum();
                if (area - polygon.unsigned_area()).abs() > 1e-8 * polygon.unsigned_area().max(1.0)
                {
                    return Err("Stock forbidden-region triangulation lost area".into());
                }
                for triangle in triangles {
                    shapes.push(original(&LineString::from(vec![
                        triangle.v1(),
                        triangle.v2(),
                        triangle.v3(),
                    ]))?);
                }
            }
        }
        Ok(SPStockConstraints {
            max_width,
            holes: InferiorQualityZone::new(0, shapes).map_err(|e| e.to_string())?,
            boards: domains,
        })
    }
}

fn holes(
    outer: &Polygon<f64>,
    holes: Vec<Vec<[f32; 2]>>,
    height: f32,
    max_x: f32,
) -> Result<MultiPolygon<f64>, String> {
    if holes.len() > 500 {
        return Err("Invalid stock dimensions or geometry size".into());
    }
    let mut region = MultiPolygon(vec![]);
    for points in holes {
        let hole = ring(points, height, max_x)?;
        if !outer.contains(&hole) || outer.exterior().intersects(hole.exterior()) {
            return Err("Stock holes must be strictly inside the outer ring".into());
        }
        region = region.union(&MultiPolygon(vec![hole]));
    }
    Ok(region)
}

fn ring(mut points: Vec<[f32; 2]>, height: f32, max_x: f32) -> Result<Polygon<f64>, String> {
    if points.len() > 1 && points.first() == points.last() {
        points.pop();
    }
    if points.len() < 3
        || points.iter().any(|p| {
            !p[0].is_finite()
                || !p[1].is_finite()
                || p[0] < 0.0
                || p[0] > max_x
                || p[1] < 0.0
                || p[1] > height
        })
    {
        return Err("Stock rings require at least 3 finite vertices within material bounds".into());
    }
    let polygon = Polygon::new(
        LineString::from(
            points
                .into_iter()
                .map(|p| (f64::from(p[0]), f64::from(p[1])))
                .collect::<Vec<_>>(),
        ),
        vec![],
    );
    if !polygon.is_valid()
        || polygon.unsigned_area() <= 0.0
        || polygon.exterior().0.windows(2).any(|p| p[0] == p[1])
    {
        return Err("Stock rings must be simple nondegenerate polygons".into());
    }
    Ok(polygon)
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::{Value, json};

    fn rectangle(x: f32, y: f32, width: f32, height: f32) -> Value {
        json!([
            [x, y],
            [x + width, y],
            [x + width, y + height],
            [x, y + height]
        ])
    }

    fn board_geometry(boards: Value, width: f32) -> Value {
        json!({
            "outer": rectangle(0.0, 0.0, width, 100.0),
            "holes": [],
            "boards": boards
        })
    }

    fn constraints(geometry: Value) -> Result<SPStockConstraints, String> {
        parse(&json!({"stock_geometry": geometry}).to_string(), 100.0).map(|stock| stock.unwrap())
    }

    #[test]
    fn boards_reserve_seams_top_blank_and_board_holes_without_offsets() {
        let stock = constraints(board_geometry(
            json!([
                {"outer": rectangle(0.0, 0.0, 40.0, 60.0),
                 "holes": [rectangle(10.0, 10.0, 10.0, 10.0)]},
                {"outer": rectangle(50.0, 0.0, 50.0, 80.0)}
            ]),
            100.0,
        ))
        .unwrap();
        assert_eq!(stock.max_width, 100.0);
        assert!((stock.holes.area() - 3700.0).abs() < 0.01);
        for (original, collision) in stock.holes.shapes_orig.iter().zip(&stock.holes.shapes_cd) {
            assert_eq!(original.shape.vertices, collision.vertices);
            assert_eq!(original.modify_config.offset, None);
            assert_eq!(original.modify_config.simplify_tolerance, None);
        }
    }

    #[test]
    fn boards_can_be_concave_and_touch_without_overlapping() {
        let stock = constraints(board_geometry(
            json!([
                {"outer": [[0,0],[40,0],[40,40],[20,40],[20,60],[0,60]]},
                {"outer": rectangle(40.0, 0.0, 60.0, 100.0)}
            ]),
            100.0,
        ))
        .unwrap();
        assert!((stock.holes.area() - 2000.0).abs() < 0.01);
    }

    #[test]
    fn boards_reject_empty_invalid_and_out_of_bounds_regions() {
        for boards in [
            json!([]),
            json!([{"outer": []}]),
            json!([{"outer": [[0,0],[20,20],[0,20],[20,0]]}]),
            json!([{"outer": [[0,0],[20,0],[20,0],[0,20]]}]),
            json!([{"outer": [[0,0],[10,0],[20,0]]}]),
            json!([{"outer": rectangle(-1.0, 0.0, 10.0, 10.0)}]),
            json!([{"outer": rectangle(95.0, 0.0, 10.0, 10.0)}]),
            json!([{"outer": rectangle(0.0, 95.0, 10.0, 10.0)}]),
            json!([{"outer": rectangle(0.0, -1.0, 10.0, 10.0)}]),
            json!([{"outer": [[0,0],[1e100,0],[0,10]]}]),
        ] {
            assert!(
                constraints(board_geometry(boards.clone(), 100.0)).is_err(),
                "{boards}"
            );
        }
    }

    #[test]
    fn boards_require_rectangular_bounds_and_empty_top_level_holes() {
        let boards = json!([{"outer": rectangle(10.0, 10.0, 20.0, 20.0)}]);
        let mut geometry = board_geometry(boards.clone(), 100.0);
        geometry["holes"] = json!([rectangle(40.0, 40.0, 10.0, 10.0)]);
        assert!(constraints(geometry).is_err());
        for outer in [
            rectangle(5.0, 0.0, 95.0, 100.0),
            rectangle(0.0, 0.0, 100.0, 90.0),
            json!([[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100]]),
        ] {
            let mut geometry = board_geometry(boards.clone(), 100.0);
            geometry["outer"] = outer;
            assert!(constraints(geometry).is_err());
        }
    }

    #[test]
    fn boards_reject_overlapping_outer_regions_even_inside_another_board_hole() {
        for boards in [
            json!([{"outer": rectangle(0.0, 0.0, 60.0, 60.0)},
                   {"outer": rectangle(50.0, 0.0, 50.0, 60.0)}]),
            json!([{"outer": rectangle(0.0, 0.0, 100.0, 100.0)},
                   {"outer": rectangle(0.0, 0.0, 100.0, 100.0)}]),
            json!([{"outer": rectangle(0.0, 0.0, 100.0, 100.0),
                    "holes": [rectangle(20.0, 20.0, 60.0, 60.0)]},
                   {"outer": rectangle(30.0, 30.0, 40.0, 40.0)}]),
        ] {
            let error = constraints(board_geometry(boards, 100.0)).err().unwrap();
            assert!(error.contains("must not overlap"), "{error}");
        }
    }

    #[test]
    fn board_holes_remain_strictly_inside_and_may_overlap_each_other() {
        for hole in [
            rectangle(0.0, 10.0, 10.0, 10.0),
            rectangle(45.0, 10.0, 10.0, 10.0),
            rectangle(60.0, 10.0, 10.0, 10.0),
            json!([[10, 10], [30, 30], [10, 30], [30, 10]]),
        ] {
            assert!(
                constraints(board_geometry(
                    json!([
                        {"outer": rectangle(0.0, 0.0, 50.0, 100.0), "holes": [hole]}
                    ]),
                    100.0
                ))
                .is_err()
            );
        }
        let stock = constraints(board_geometry(
            json!([
                {"outer": rectangle(0.0, 0.0, 100.0, 100.0),
                 "holes": [rectangle(20.0, 20.0, 30.0, 30.0), rectangle(40.0, 20.0, 30.0, 30.0)]}
            ]),
            100.0,
        ))
        .unwrap();
        assert!((stock.holes.area() - 1500.0).abs() < 0.01);
        let too_many = vec![rectangle(10.0, 10.0, 10.0, 10.0); 501];
        assert!(
            constraints(board_geometry(
                json!([
                    {"outer": rectangle(0.0, 0.0, 100.0, 100.0), "holes": too_many}
                ]),
                100.0
            ))
            .is_err()
        );
    }

    #[test]
    fn virtual_width_limit_does_not_relax_physical_board_or_single_stock_limits() {
        let boards = json!([
            {"outer": rectangle(0.0, 0.0, 100_000.0, 100.0)},
            {"outer": rectangle(100_010.0, 0.0, 100_000.0, 100.0)}
        ]);
        let stock = constraints(board_geometry(boards.clone(), 200_010.0)).unwrap();
        assert_eq!(stock.max_width, 200_010.0);
        assert!((stock.holes.area() - 1000.0).abs() < 0.01);
        assert!(constraints(json!({"outer": rectangle(0.0, 0.0, 200_010.0, 100.0)})).is_err());
        assert!(
            constraints(board_geometry(
                json!([
                    {"outer": rectangle(100_000.0, 0.0, 100_001.0, 100.0)}
                ]),
                200_001.0
            ))
            .is_err()
        );
        assert!(constraints(board_geometry(boards, MAX_VIRTUAL_WIDTH + 1.0)).is_err());
        for height in [0.0, -1.0, 100_001.0, f32::INFINITY, f32::NAN] {
            let input = json!({"stock_geometry": board_geometry(json!([
                {"outer": rectangle(0.0, 0.0, 10.0, 10.0)}
            ]), 100.0)})
            .to_string();
            assert!(parse(&input, height).is_err());
        }
    }

    #[test]
    fn virtual_limit_preserves_representable_unit_seam_and_hole_coordinates() {
        let stock = constraints(board_geometry(
            json!([
                {"outer": rectangle(0.0, 0.0, 10.0, 100.0)},
                {"outer": rectangle(MAX_VIRTUAL_WIDTH - 21.0, 0.0, 10.0, 100.0),
                 "holes": [rectangle(MAX_VIRTUAL_WIDTH - 19.0, 20.0, 2.0, 10.0)]},
                {"outer": rectangle(MAX_VIRTUAL_WIDTH - 10.0, 0.0, 10.0, 100.0)}
            ]),
            MAX_VIRTUAL_WIDTH,
        ))
        .unwrap();
        assert_eq!(stock.max_width, MAX_VIRTUAL_WIDTH);
        let seam = stock
            .holes
            .shapes_cd
            .iter()
            .find(|shape| {
                shape.bbox.x_min == MAX_VIRTUAL_WIDTH - 11.0
                    && shape.bbox.x_max == MAX_VIRTUAL_WIDTH - 10.0
            })
            .unwrap();
        assert_eq!(seam.area, 100.0);
        assert!(
            stock
                .holes
                .shapes_cd
                .iter()
                .any(|shape| shape.bbox.x_min == MAX_VIRTUAL_WIDTH - 19.0
                    && shape.bbox.x_max == MAX_VIRTUAL_WIDTH - 17.0
                    && shape.area == 20.0)
        );
        assert!(
            constraints(board_geometry(
                json!([
                    {"outer": [[9999990,0],[9999990.1,0],[9999990.1,10],[9999990,10]]}
                ]),
                MAX_VIRTUAL_WIDTH
            ))
            .is_err()
        );
    }

    #[test]
    fn legacy_missing_or_null_boards_and_closed_rings_remain_compatible() {
        for boards in [None, Some(Value::Null)] {
            let mut geometry = json!({"outer": rectangle(0.0, 0.0, 100.0, 100.0),
                "holes": [rectangle(20.0, 20.0, 10.0, 10.0)]});
            if let Some(boards) = boards {
                geometry["boards"] = boards;
            }
            assert_eq!(constraints(geometry).unwrap().holes.area(), 100.0);
        }
        let geometry = json!({"outer": [[0,0],[100,0],[100,100],[0,100],[0,0]],
            "boards": [{"outer": [[0,0],[100,0],[100,100],[0,100],[0,0]]}]});
        assert_eq!(constraints(geometry).unwrap().holes.area(), 0.0);
    }

    #[test]
    fn accepts_stock_outlines_above_previous_vertex_caps() {
        let points: Vec<_> = (0..4)
            .flat_map(|edge| {
                (0..2501).map(move |i| {
                    let t = i as f32 * 100.0 / 2501.0;
                    match edge {
                        0 => [t, 0.0],
                        1 => [100.0, t],
                        2 => [100.0 - t, 100.0],
                        _ => [0.0, 100.0 - t],
                    }
                })
            })
            .collect();
        let stock = StockGeometry {
            outer: points,
            holes: vec![],
            boards: None,
        };
        stock.constraints(100.0).unwrap();
        assert!(
            ring(
                vec![[0.0, 0.0], [100_001.0, 0.0], [0.0, 1.0]],
                100.0,
                MAX_BOARD_DIMENSION
            )
            .is_err()
        );
    }
}

fn stock_shape(
    mut points: Vec<Point>,
    surrogate: Option<jagua_rs::geometry::fail_fast::SPSurrogateConfig>,
) -> Result<SPolygon, String> {
    let min_x = points.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
    let max_x = points.iter().map(|p| p.0).fold(f32::NEG_INFINITY, f32::max);
    let width = max_x - min_x;
    let translation = if min_x > MAX_BOARD_DIMENSION || width > MAX_BOARD_DIMENSION {
        min_x
    } else {
        0.0
    };
    let min_y = points.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
    let max_y = points.iter().map(|p| p.1).fold(f32::NEG_INFINITY, f32::max);
    let height = max_y - min_y;
    let scale_x = (width / (height * 32.0)).max(1.0);
    let scale_y = (height / (width * 32.0)).max(1.0);
    if translation == 0.0 && scale_x == 1.0 && scale_y == 1.0 {
        return SPolygon::new(points).map_err(|e| format!("Invalid stock forbidden polygon: {e}"));
    }
    if SPolygon::calculate_area(&points) < 0.0 {
        points.reverse();
    }
    let local = points
        .iter()
        .map(|p| Point((p.0 - translation) / scale_x, (p.1 - min_y) / scale_y))
        .collect();
    let mut shape =
        SPolygon::new(local).map_err(|e| format!("Invalid stock forbidden polygon: {e}"))?;
    if let Some(config) = surrogate {
        shape
            .generate_surrogate(config)
            .map_err(|e| e.to_string())?;
    }
    // The native pole search has finite depth and f32 cells. Normalize its
    // working coordinates; restore exact polygon vertices without expansion.
    // Axis stretches never shrink distances, so unchanged pole radii remain inscribed.
    shape.poi.center.0 = shape.poi.center.0 * scale_x + translation;
    shape.poi.center.1 = shape.poi.center.1 * scale_y + min_y;
    if let Some(surrogate) = &mut shape.surrogate {
        for pole in &mut surrogate.poles {
            pole.center.0 = pole.center.0 * scale_x + translation;
            pole.center.1 = pole.center.1 * scale_y + min_y;
        }
        for pier in &mut surrogate.piers {
            pier.start.0 = pier.start.0 * scale_x + translation;
            pier.start.1 = pier.start.1 * scale_y + min_y;
            pier.end.0 = pier.end.0 * scale_x + translation;
            pier.end.1 = pier.end.1 * scale_y + min_y;
        }
        surrogate.convex_hull_area *= scale_x * scale_y;
    }
    shape.vertices = points;
    shape.area = SPolygon::calculate_area(&shape.vertices).abs();
    shape.diameter = SPolygon::calculate_diameter(shape.vertices.clone());
    shape.bbox = SPolygon::generate_bounding_box(&shape.vertices);
    Ok(shape)
}

fn original(ring: &LineString<f64>) -> Result<OriginalShape, String> {
    let mut points: Vec<_> = ring
        .0
        .iter()
        .map(|p| Point(p.x as f32, p.y as f32))
        .collect();
    if points.first() == points.last() {
        points.pop();
    }
    let shape = stock_shape(points, None)?;
    Ok(OriginalShape {
        shape,
        pre_transform: DTransformation::empty(),
        modify_mode: ShapeModifyMode::Inflate,
        // Parts already receive the solver's half-clearance offset. Never offset
        // decomposed stock polygons: that would also inflate their shared edges.
        modify_config: ShapeModifyConfig::default(),
    })
}
