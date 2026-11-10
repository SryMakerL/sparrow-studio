use super::*;
use geo::{BooleanOps, BoundingRect};
use rand::seq::SliceRandom;

pub(crate) fn run(
    job: &Job,
    initial: Option<&Value>,
    seed: u64,
    revision: u32,
    budget_ms: f64,
    interrupted: &dyn Fn() -> bool,
) -> Option<Value> {
    let started = Instant::now();
    let deadline = started + Duration::from_secs_f64(budget_ms.max(0.0) / 1000.0);
    let stopped = || interrupted() || Instant::now() >= deadline;
    let stock = sheets::stocks(job).into_iter().next()?;
    let (outer, holes) = match stock.shape {
        StockShape::Rectangle => (
            vec![
                [0.0, 0.0],
                [stock.length_mm, 0.0],
                [stock.length_mm, stock.width_mm],
                [0.0, stock.width_mm],
            ],
            vec![],
        ),
        StockShape::Polygon { outer, holes, .. } => (outer, holes),
    };
    let board = Polygon::new(
        validation::polygon(&outer).exterior().clone(),
        holes
            .iter()
            .map(|h| validation::polygon(h).exterior().clone())
            .collect(),
    );
    let mut copies = job
        .parts
        .iter()
        .flat_map(|part| (0..part.quantity).map(move |copy| (part, copy)))
        .collect::<Vec<_>>();
    copies.sort_by(|a, b| {
        validation::polygon(&b.0.outer)
            .unsigned_area()
            .total_cmp(&validation::polygon(&a.0.outer).unsigned_area())
    });
    let mut rng = Xoshiro256PlusPlus::seed_from_u64(seed);
    let mut best: Option<Value> = None;
    for round in 0.. {
        if stopped() {
            break;
        }
        let mut order = copies.clone();
        if round > 0 {
            let offset = round % order.len().max(1);
            order.rotate_left(offset);
            if round % 3 == 0 {
                order.shuffle(&mut rng);
            }
        }
        order.sort_by_key(|(part, _)| std::cmp::Reverse(part.priority));
        let mut placements = if round == 0 {
            initial
                .and_then(|v| v["placements"].as_array())
                .cloned()
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let mut rings = Vec::new();
        for p in &placements {
            let part = job
                .parts
                .iter()
                .find(|part| Some(part.id.as_str()) == p["partId"].as_str())?;
            rings.push(validation::transform(
                &part.outer,
                p["xMm"].as_f64()?,
                p["yMm"].as_f64()?,
                p["angleDeg"].as_f64()?,
            ));
        }
        for (part, copy) in order {
            if stopped() {
                break;
            }
            if placements
                .iter()
                .any(|p| p["partId"] == part.id && p["copyIndex"] == copy)
            {
                continue;
            }
            let angles = match &part.rotations {
                Rotations::Discrete { degrees } => degrees.clone(),
                Rotations::Continuous => (0..72).map(|i| ((i + round) % 72) as f64 * 5.0).collect(),
            };
            let mut chosen: Option<(Value, Ring, f64, f64, f64)> = None;
            for angle in angles {
                if stopped() {
                    break;
                }
                let rotated = validation::transform(&part.outer, 0.0, 0.0, angle);
                let bbox = validation::polygon(&rotated).bounding_rect()?;
                let anchors = outer
                    .iter()
                    .chain(holes.iter().flatten())
                    .chain(rings.iter().flatten())
                    .collect::<Vec<_>>();
                let mut candidates = Vec::new();
                for target in anchors.iter().step_by(anchors.len().div_ceil(96).max(1)) {
                    for vertex in rotated.iter().step_by(rotated.len().div_ceil(96).max(1)) {
                        let x = target[0] - vertex[0];
                        let y = target[1] - vertex[1];
                        candidates.push((x, y));
                        let gap = job.settings.clearance_mm;
                        if gap > 0.0 {
                            for (dx, dy) in [(gap, 0.0), (-gap, 0.0), (0.0, gap), (0.0, -gap)] {
                                candidates.push((x + dx, y + dy));
                            }
                        }
                    }
                }
                for y in 0..=12 {
                    for x in 0..=12 {
                        candidates.push((
                            (stock.length_mm - bbox.width()) * f64::from(x) / 12.0 - bbox.min().x,
                            (stock.width_mm - bbox.height()) * f64::from(y) / 12.0 - bbox.min().y,
                        ));
                    }
                }
                candidates.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.total_cmp(&b.0)));
                for (x, y) in candidates {
                    if stopped() {
                        break;
                    }
                    let ring = rotated
                        .iter()
                        .map(|p| [p[0] + x, p[1] + y])
                        .collect::<Ring>();
                    let poly = validation::polygon(&ring);
                    let b = poly.bounding_rect()?;
                    if b.min().x < -1e-6
                        || b.min().y < -1e-6
                        || b.max().x > stock.length_mm + 1e-6
                        || b.max().y > stock.width_mm + 1e-6
                        || poly.difference(&board).unsigned_area() > 1e-8
                    {
                        continue;
                    }
                    if rings.iter().any(|r| {
                        poly.intersection(&validation::polygon(r)).unsigned_area() > 1e-8
                            || (job.settings.clearance_mm > 0.0
                                && validation::distance(&ring, r) + 1e-6
                                    < job.settings.clearance_mm)
                    }) {
                        continue;
                    }
                    if chosen.as_ref().is_none_or(|(_, _, bx, by, ba)| {
                        b.max().x < *bx - 1e-6
                            || ((b.max().x - bx).abs() <= 1e-6
                                && (b.min().y < *by - 1e-6
                                    || ((b.min().y - by).abs() <= 1e-6 && angle < *ba)))
                    }) {
                        chosen = Some((
                            json!({"partId":part.id,"copyIndex":copy,"xMm":x,"yMm":y,"angleDeg":angle}),
                            ring,
                            b.max().x,
                            b.min().y,
                            angle,
                        ));
                    }
                    break;
                }
                if chosen.is_some() && matches!(part.rotations, Rotations::Continuous) {
                    break;
                }
            }
            let Some((p, r, _, _, _)) = chosen else {
                break;
            };
            placements.push(p);
            rings.push(r);
        }
        if placements.len() == copies.len() && !stopped() {
            let used = rings
                .iter()
                .map(|r| validation::polygon(r).bounding_rect().unwrap().max().x)
                .fold(0.0, f64::max);
            if best
                .as_ref()
                .is_none_or(|b| used < b["usedLengthMm"].as_f64().unwrap())
            {
                let mut result = json!({"documentRevision":revision,"solverRevision":SOLVER_REVISION,"seed":seed.to_string(),"elapsedSeconds":started.elapsed().as_secs_f64(),"usedLengthMm":used,"placements":placements});
                result["validation"] = validation::check(job, &result);
                if result["validation"]["status"] == "passed" {
                    best = Some(result);
                }
            }
            if best.is_some() && job.settings.solver_preset == "fast" {
                break;
            }
        }
    }
    best
}
