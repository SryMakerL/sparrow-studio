use super::*;
use geo::{BooleanOps, BoundingRect};

const LINEAR: f64 = 1e-6;
const OVERLAP: f64 = 1e-8;

pub(crate) fn polygon(points: &Ring) -> Polygon<f64> {
    Polygon::new(
        LineString::from(points.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>()),
        vec![],
    )
}

pub(crate) fn transform(points: &Ring, x: f64, y: f64, angle: f64) -> Ring {
    let (s, c) = angle.to_radians().sin_cos();
    points
        .iter()
        .map(|p| [p[0] * c - p[1] * s + x, p[0] * s + p[1] * c + y])
        .collect()
}

fn point_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let d = dx * dx + dy * dy;
    let t = if d == 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d).clamp(0.0, 1.0)
    };
    (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy)
}

pub(crate) fn distance(a: &Ring, b: &Ring) -> f64 {
    let mut min = f64::INFINITY;
    for (i, &p) in a.iter().enumerate() {
        let q = a[(i + 1) % a.len()];
        let ab = geo::Line::new((p[0], p[1]), (q[0], q[1]));
        for (j, &r) in b.iter().enumerate() {
            let s = b[(j + 1) % b.len()];
            if ab.intersects(&geo::Line::new((r[0], r[1]), (s[0], s[1]))) {
                return 0.0;
            }
            min = min
                .min(point_segment(p, r, s))
                .min(point_segment(q, r, s))
                .min(point_segment(r, p, q))
                .min(point_segment(s, p, q));
        }
    }
    min
}

fn number(v: &Value, key: &str) -> Result<f64, String> {
    v[key]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("Invalid finite {key}"))
}

pub(crate) fn check(job: &Job, result: &Value) -> Value {
    let mut overlap: f64 = 0.0;
    let mut boundary: f64 = 0.0;
    let mut gap: Option<f64> = None;
    let checked = (|| -> Result<(), String> {
        if result.get("sheets").is_some() {
            return aggregate(job, result);
        }
        if job.settings.auto_add_sheets
            || job.settings.sheet_count.is_some()
            || job.settings.sheet_stocks.is_some()
        {
            return Err("A multi-sheet job requires a sheet aggregate".into());
        }
        let used = number(result, "usedLengthMm")?;
        if used <= 0.0
            || used > 100_000.0
            || job
                .settings
                .sheet_length_mm
                .is_some_and(|length| used > length + LINEAR)
        {
            return Err("Invalid used length or layout exceeds sheet length".into());
        }
        let placements = result["placements"]
            .as_array()
            .ok_or("Missing placements")?;
        let demand = job
            .parts
            .iter()
            .try_fold(0usize, |a, p| a.checked_add(p.quantity))
            .ok_or("Demand overflow")?;
        if placements.len() != demand {
            return Err("Layout does not contain exactly the demanded copies".into());
        }
        let mut seen = HashSet::new();
        let mut world = Vec::new();
        for placement in placements {
            let id = placement["partId"]
                .as_str()
                .ok_or("Missing part identity")?;
            let part = job
                .parts
                .iter()
                .find(|p| p.id == id)
                .ok_or("Unknown part")?;
            let copy = placement["copyIndex"]
                .as_u64()
                .ok_or("Invalid copy index")?;
            if copy >= part.quantity as u64 || !seen.insert((id, copy)) {
                return Err("Unknown or duplicate part copy".into());
            }
            if placement
                .as_object()
                .ok_or("Invalid placement")?
                .keys()
                .any(|k| !["partId", "copyIndex", "xMm", "yMm", "angleDeg"].contains(&k.as_str()))
            {
                return Err("Placements support rigid transforms only".into());
            }
            let angle = number(placement, "angleDeg")?;
            if let Rotations::Discrete { degrees } = &part.rotations
                && !degrees
                    .iter()
                    .any(|a| ((angle - a + 180.0).rem_euclid(360.0) - 180.0).abs() <= 1e-4)
            {
                return Err("Disallowed rotation".into());
            }
            let x = number(placement, "xMm")?;
            let y = number(placement, "yMm")?;
            let outer = transform(&part.outer, x, y, angle);
            let holes = part
                .holes
                .iter()
                .map(|h| transform(h, x, y, angle))
                .collect::<Vec<_>>();
            if outer
                .iter()
                .chain(holes.iter().flatten())
                .flatten()
                .any(|v| !v.is_finite() || v.abs() > 100_000.0)
            {
                return Err("Invalid world coordinates".into());
            }
            let topology = Polygon::new(
                polygon(&outer).exterior().clone(),
                holes
                    .iter()
                    .map(|h| polygon(h).exterior().clone())
                    .collect(),
            );
            if !topology.is_valid() || topology.unsigned_area() <= 1e-10 {
                return Err("Invalid f64 world polygon topology".into());
            }
            let poly = polygon(&outer);
            let bbox = poly.bounding_rect().ok_or("Empty world geometry")?;
            boundary = boundary
                .max(-bbox.min().x)
                .max(-bbox.min().y)
                .max(bbox.max().x - used)
                .max(bbox.max().y - job.settings.material_width_mm);
            if let Some(SheetStock {
                shape: StockShape::Polygon { outer, holes, .. },
                ..
            }) = &job.settings.sheet_stock
            {
                let stock = Polygon::new(
                    polygon(outer).exterior().clone(),
                    holes
                        .iter()
                        .map(|h| polygon(h).exterior().clone())
                        .collect(),
                );
                if poly.difference(&stock).unsigned_area() > OVERLAP {
                    return Err("Part crosses polygon stock boundary or enters a stock hole".into());
                }
            }
            world.push((outer, poly));
        }
        if boundary > LINEAR {
            return Err(format!("Material boundary exceeded by {boundary} mm"));
        }
        let mut operations = 0usize;
        for i in 0..world.len() {
            for j in 0..i {
                let a = world[i].1.bounding_rect().unwrap();
                let b = world[j].1.bounding_rect().unwrap();
                let box_distance = (a.min().x - b.max().x)
                    .max(b.min().x - a.max().x)
                    .max(0.0)
                    .hypot((a.min().y - b.max().y).max(b.min().y - a.max().y).max(0.0));
                if box_distance == 0.0 {
                    overlap = overlap.max(world[i].1.intersection(&world[j].1).unsigned_area());
                }
                if job.settings.clearance_mm > 0.0 && gap.is_none_or(|g| box_distance < g) {
                    operations = operations
                        .saturating_add(world[i].0.len().saturating_mul(world[j].0.len()));
                    if operations > 50_000_000 {
                        return Err("Clearance check exceeded its segment budget".into());
                    }
                    let d = distance(&world[i].0, &world[j].0);
                    gap = Some(gap.map_or(d, |g| g.min(d)));
                }
            }
        }
        if overlap > OVERLAP {
            return Err(format!("Copies overlap by {overlap} mm2"));
        }
        if gap.is_some_and(|g| g + LINEAR < job.settings.clearance_mm) {
            return Err("Minimum clearance below requested clearance".into());
        }
        Ok(())
    })();
    json!({"status":if checked.is_ok(){"passed"}else{"failed"},"overlapAreaMm2":overlap,"maxBoundaryViolationMm":boundary,"minClearanceMm":gap,"errors":checked.err().into_iter().collect::<Vec<_>>()})
}

fn aggregate(job: &Job, result: &Value) -> Result<(), String> {
    let sheets = result["sheets"].as_array().ok_or("Missing sheets")?;
    let unplaced = result["unplaced"].as_array().ok_or("Missing unplaced")?;
    if !result["placements"].as_array().is_some_and(Vec::is_empty) {
        return Err("Aggregate placements must be empty".into());
    }
    let stocks = sheets::stocks(job);
    let capacity = if job.settings.auto_add_sheets {
        if stocks.len() != 1
            || job.settings.sheet_count.is_some()
            || job.settings.sheet_stocks.is_some()
            || job.settings.sheet_length_mm.is_none()
        {
            return Err("Automatic sheets require one fixed stock specification".into());
        }
        sheets::demanded_copies(job)?
    } else {
        stocks
            .iter()
            .try_fold(0usize, |n, s| n.checked_add(s.quantity))
            .ok_or("Stock count overflow")?
    };
    if stocks.is_empty()
        || sheets.len() > capacity
        || job
            .settings
            .sheet_count
            .is_some_and(|count| sheets.len() > count)
    {
        return Err("Invalid sheet aggregate or inventory exhausted".into());
    }
    let mut totals = vec![0usize; job.parts.len()];
    let mut used = std::collections::HashMap::new();
    let mut length = 0.0;
    for sheet in sheets {
        let child: Job = serde_json::from_value(sheet["job"].clone()).map_err(|e| e.to_string())?;
        if child.settings.auto_add_sheets
            || child.settings.sheet_count.is_some()
            || child.settings.sheet_stocks.is_some()
            || sheet["result"].get("sheets").is_some()
            || sheet["result"].get("unplaced").is_some()
        {
            return Err("Nested sheet aggregates are not supported".into());
        }
        let stock = child
            .settings
            .sheet_stock
            .as_ref()
            .ok_or("Missing sheet stock snapshot")?;
        let original = stocks
            .iter()
            .find(|s| s.id == stock.id)
            .ok_or("Unknown sheet stock")?;
        if serde_json::to_value(original).unwrap() != serde_json::to_value(stock).unwrap()
            || child.settings.material_width_mm != original.width_mm
            || child.settings.sheet_length_mm != Some(original.length_mm)
            || child.settings.clearance_mm != job.settings.clearance_mm
        {
            return Err("Sheet stock snapshot differs from inventory".into());
        }
        let count = used.entry(stock.id.clone()).or_insert(0usize);
        *count += 1;
        if !job.settings.auto_add_sheets && *count > original.quantity {
            return Err("Sheet inventory exhausted".into());
        }
        let mut ids = HashSet::new();
        for part in &child.parts {
            let i = job
                .parts
                .iter()
                .position(|p| p.id == part.id)
                .ok_or("Unknown sheet part")?;
            if !ids.insert(&part.id) {
                return Err("Duplicate sheet part".into());
            }
            let original = &job.parts[i];
            if part.outer != original.outer
                || part.holes != original.holes
                || serde_json::to_value(&part.rotations).unwrap()
                    != serde_json::to_value(&original.rotations).unwrap()
            {
                return Err("Sheet part differs from job".into());
            }
            totals[i] = totals[i]
                .checked_add(part.quantity)
                .ok_or("Quantity overflow")?;
        }
        if !sheet["result"]["placements"]
            .as_array()
            .is_some_and(|placements| !placements.is_empty())
        {
            return Err("Aggregate sheets must not be empty".into());
        }
        let checked = check(&child, &sheet["result"]);
        if checked["status"] != "passed" {
            return Err(checked["errors"].to_string());
        }
        length += number(&sheet["result"], "usedLengthMm")?;
    }
    let mut seen = HashSet::new();
    for p in unplaced {
        let id = p["partId"].as_str().ok_or("Invalid unplaced identity")?;
        let i = job
            .parts
            .iter()
            .position(|p| p.id == id)
            .ok_or("Unknown unplaced part")?;
        let n = p["quantity"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or("Invalid unplaced quantity")?;
        if !seen.insert(id) {
            return Err("Duplicate unplaced part".into());
        }
        totals[i] = totals[i]
            .checked_add(usize::try_from(n).map_err(|_| "Quantity overflow")?)
            .ok_or("Quantity overflow")?;
    }
    if totals.iter().zip(&job.parts).any(|(n, p)| *n != p.quantity) {
        return Err("Placed and unplaced quantities do not match job".into());
    }
    if (number(result, "usedLengthMm")? - length).abs() > LINEAR {
        return Err("Aggregate used length differs from sheets".into());
    }
    Ok(())
}
