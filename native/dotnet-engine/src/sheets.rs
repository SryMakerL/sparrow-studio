use super::*;
use geo::{BooleanOps, BoundingRect};

pub(crate) fn stocks(job: &Job) -> Vec<SheetStock> {
    job.settings.sheet_stocks.clone().unwrap_or_else(|| {
        vec![
            job.settings
                .sheet_stock
                .clone()
                .unwrap_or_else(|| SheetStock {
                    id: "legacy".into(),
                    name: "Sheet".into(),
                    quantity: job.settings.sheet_count.unwrap_or(1),
                    priority: 0,
                    width_mm: job.settings.material_width_mm,
                    length_mm: job.settings.sheet_length_mm.unwrap_or(100000.0),
                    shape: StockShape::Rectangle,
                }),
        ]
    })
}

pub(crate) fn demanded_copies(job: &Job) -> Result<usize, String> {
    job.parts
        .iter()
        .try_fold(0usize, |n, p| n.checked_add(p.quantity))
        .ok_or_else(|| "Demand overflow".into())
}

pub(crate) fn validate_stocks(job: &Job) -> Result<(), String> {
    if job.settings.auto_add_sheets {
        if job.settings.sheet_count.is_some()
            || job.settings.sheet_stocks.is_some()
            || job.settings.sheet_length_mm.is_none()
        {
            return Err(
                "autoAddSheets requires one sheet specification, no sheetCount or sheetStocks"
                    .into(),
            );
        }
        demanded_copies(job)?;
    }
    if job
        .settings
        .sheet_stocks
        .as_ref()
        .is_some_and(Vec::is_empty)
    {
        return Err("Supply at least one sheet stock type".into());
    }
    let mut ids = HashSet::new();
    let inventory = if let Some(v) = &job.settings.sheet_stocks {
        v.clone()
    } else {
        job.settings.sheet_stock.clone().into_iter().collect()
    };
    for s in inventory {
        if s.id.is_empty()
            || !ids.insert(s.id)
            || s.quantity == 0
            || !(0..=999).contains(&s.priority)
            || !positive(s.width_mm)
            || !positive(s.length_mm)
        {
            return Err("Invalid stock identity, quantity, priority or dimensions".into());
        }
        if let StockShape::Polygon {
            outer,
            holes,
            approximation_tolerance_mm,
        } = &s.shape
        {
            geometry(outer, holes)?;
            if approximation_tolerance_mm.is_some_and(|v| !tolerance(v))
                || outer
                    .iter()
                    .chain(holes.iter().flatten())
                    .any(|p| p[0] < 0.0 || p[1] < 0.0 || p[0] > s.length_mm || p[1] > s.width_mm)
            {
                return Err("Invalid stock geometry extent or tolerance".into());
            }
        }
    }
    Ok(())
}

pub(crate) fn parse(input: &str) -> Result<Job, String> {
    if input.len() > MAX_JSON {
        return Err("Input exceeds 10 MiB".into());
    }
    let mut job: Job = serde_json::from_str(input).map_err(|e| format!("Invalid Job JSON: {e}"))?;
    fn normalize(r: &mut Ring) {
        r.dedup();
        if r.len() > 1 && r.first() == r.last() {
            r.pop();
        }
    }
    for p in &mut job.parts {
        normalize(&mut p.outer);
        for h in &mut p.holes {
            normalize(h);
        }
    }
    fn normalize_stock(s: &mut SheetStock) -> Result<(), String> {
        if let StockShape::Polygon { outer, holes, .. } = &mut s.shape {
            normalize(outer);
            for h in holes.iter_mut() {
                normalize(h);
            }
            geometry(outer, holes)?;
            let bbox = validation::polygon(outer)
                .bounding_rect()
                .ok_or("Empty stock")?;
            for p in outer.iter_mut().chain(holes.iter_mut().flatten()) {
                p[0] -= bbox.min().x;
                p[1] -= bbox.min().y;
            }
            s.length_mm = bbox.width();
            s.width_mm = bbox.height();
        }
        Ok(())
    }
    if let Some(stocks) = &mut job.settings.sheet_stocks {
        for s in stocks {
            normalize_stock(s)?;
        }
    }
    if let Some(s) = &mut job.settings.sheet_stock {
        normalize_stock(s)?;
    }
    validate(&job)?;
    Ok(job)
}

fn aggregate(
    job: &Job,
    entries: &[Value],
    remaining: &[usize],
    seed: u64,
    revision: u32,
    started: Instant,
) -> Value {
    let mut v = json!({"documentRevision":revision,"solverRevision":SOLVER_REVISION,"seed":seed.to_string(),"elapsedSeconds":started.elapsed().as_secs_f64(),"usedLengthMm":entries.iter().map(|s|s["result"]["usedLengthMm"].as_f64().unwrap()).sum::<f64>(),"placements":[],"sheets":entries,"unplaced":job.parts.iter().zip(remaining).filter(|(_,n)|**n>0).map(|(p,n)|json!({"partId":p.id,"quantity":n})).collect::<Vec<_>>()});
    v["validation"] = validation::check(job, &v);
    v
}

fn score(job: &Job, v: &Value) -> Vec<f64> {
    let mut priorities = job.parts.iter().map(|p| p.priority).collect::<Vec<_>>();
    priorities.sort_unstable_by(|a, b| b.cmp(a));
    priorities.dedup();
    let mut score = priorities
        .iter()
        .map(|priority| {
            v["unplaced"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| {
                    job.parts.iter().any(|part| {
                        part.id == p["partId"].as_str().unwrap() && part.priority == *priority
                    })
                })
                .map(|p| p["quantity"].as_u64().unwrap() as f64)
                .sum()
        })
        .collect::<Vec<f64>>();
    let mut inventory = stocks(job);
    inventory.sort_by_key(|s| std::cmp::Reverse(s.priority));
    let sheets = v["sheets"].as_array().unwrap();
    for s in inventory {
        score.push(
            -sheets
                .iter()
                .filter(|e| e["job"]["settings"]["sheetStock"]["id"] == s.id)
                .map(|e| e["result"]["placements"].as_array().unwrap().len() as f64)
                .sum::<f64>(),
        );
    }
    score.push(sheets.len() as f64);
    score
}

fn compare_score(job: &Job, a: &Value, b: &Value) -> std::cmp::Ordering {
    let prefix = score(job, a).partial_cmp(&score(job, b)).unwrap();
    if !prefix.is_eq() {
        return prefix;
    }
    let a_sheets = a["sheets"].as_array().unwrap();
    let b_sheets = b["sheets"].as_array().unwrap();
    if let Some(count) = job.settings.sheet_count {
        for i in 0..count.min(a_sheets.len().max(b_sheets.len())) {
            let copies = |sheets: &[Value]| {
                sheets
                    .get(i)
                    .map_or(0, |s| s["result"]["placements"].as_array().unwrap().len())
            };
            let occupancy = copies(b_sheets).cmp(&copies(a_sheets));
            if !occupancy.is_eq() {
                return occupancy;
            }
        }
    }
    a["usedLengthMm"]
        .as_f64()
        .unwrap()
        .total_cmp(&b["usedLengthMm"].as_f64().unwrap())
}

pub(crate) fn insertion_budget_ms(
    settings: &Settings,
    has_current: bool,
    deadline: Option<Instant>,
) -> f64 {
    let seconds = if has_current {
        f64::from(settings.sheet_insertion_warm_start_seconds.unwrap_or(10))
    } else {
        settings.sheet_initial_search_seconds.unwrap_or(2.5)
    };
    let budget = seconds * 1000.0;
    budget.min(deadline.map_or(budget, |d| {
        d.saturating_duration_since(Instant::now()).as_secs_f64() * 1000.0
    }))
}

pub(crate) fn run(
    input: &str,
    seed: u64,
    revision: u32,
    cancel: Option<&Cancel>,
    send: &mut dyn FnMut(Value),
) -> Result<Value, String> {
    let job = parse(input)?;
    let started = Instant::now();
    let deadline = job
        .settings
        .time_limit_seconds
        .map(|n| started + Duration::from_secs(u64::from(n)));
    let stopped = || {
        cancel.is_some_and(|c| c.requested.load(Ordering::Relaxed))
            || deadline.is_some_and(|d| Instant::now() >= d)
    };
    if !job.settings.auto_add_sheets
        && job.settings.sheet_count.is_none()
        && job.settings.sheet_stocks.is_none()
    {
        if stopped() {
            return Err("cancelled".into());
        }
        if job.settings.sheet_length_mm.is_some()
            && (job.settings.material_width_mm <= job.settings.clearance_mm
                || job.settings.sheet_length_mm.unwrap() <= job.settings.clearance_mm)
        {
            return polygon::run(
                &job,
                None,
                seed,
                revision,
                insertion_budget_ms(&job.settings, false, deadline),
                &stopped,
            )
            .ok_or_else(|| "No valid initial placement could be constructed".into());
        }
        let mut kernel = kernel::Kernel::new(job.clone())?;
        return kernel.step(&json!({"quantities":job.parts.iter().map(|p|p.quantity).collect::<Vec<_>>(),"mode":"continuous","budget_ms":job.settings.time_limit_seconds.map(|n|n*1000)}),seed,revision,cancel,send);
    }
    let mut inventory = stocks(&job);
    inventory.sort_by_key(|s| std::cmp::Reverse(s.priority));
    let initial = job.parts.iter().map(|p| p.quantity).collect::<Vec<_>>();
    let mut best = aggregate(&job, &[], &initial, seed, revision, started);
    let mut stagnant = 0;
    let mut round = 0u64;
    while !stopped() {
        let previous = best.clone();
        let mut remaining = initial.clone();
        let mut entries = Vec::new();
        let mut ordered = (0..job.parts.len()).collect::<Vec<_>>();
        ordered.sort_by(|a, b| {
            validation::polygon(&job.parts[*b].outer)
                .unsigned_area()
                .total_cmp(&validation::polygon(&job.parts[*a].outer).unsigned_area())
        });
        if !ordered.is_empty() {
            let offset = round as usize % ordered.len();
            ordered.rotate_left(offset);
        }
        if round > 0 {
            ordered.sort_by_key(|i| {
                !best["unplaced"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["partId"] == job.parts[*i].id)
            });
        }
        ordered.sort_by_key(|i| std::cmp::Reverse(job.parts[*i].priority));
        let mut failed_stocks = std::collections::HashMap::<String, u32>::new();
        for stock in &inventory {
            let mut attempts = 0;
            while if job.settings.auto_add_sheets {
                entries.len() < demanded_copies(&job)?
            } else {
                attempts < stock.quantity
            } {
                if !job.settings.auto_add_sheets {
                    attempts += 1;
                }
                if failed_stocks.get(&stock.id).copied().unwrap_or(0) >= 2 {
                    break;
                }
                if stopped() || remaining.iter().all(|n| *n == 0) {
                    break;
                }
                let mut child = job.clone();
                child.settings.auto_add_sheets = false;
                child.settings.sheet_count = None;
                child.settings.sheet_stocks = None;
                child.settings.sheet_stock = Some(stock.clone());
                child.settings.material_width_mm = stock.width_mm;
                child.settings.sheet_length_mm = Some(stock.length_mm);
                let fallback = stock.width_mm <= job.settings.clearance_mm
                    || stock.length_mm <= job.settings.clearance_mm;
                let mut kernel = if fallback {
                    None
                } else {
                    Some(kernel::Kernel::new(child.clone())?)
                };
                let mut quantities = vec![0usize; job.parts.len()];
                let mut current: Option<Value> = None;
                let mut snapshot = None;
                let failures = job.settings.sheet_insertion_failures.unwrap_or(3);
                let mut initial_pass = true;
                let mut pass = 0u32;
                let mut final_compression_deadline: Option<Instant> = None;
                loop {
                    if stopped() {
                        break;
                    }
                    if quantities != remaining {
                        send(
                            json!({"type":"progress","phase":"Insertion","roundIndex":round,"sheetIndex":entries.len(),"insertionFailures":pass}),
                        );
                    }
                    let before = quantities.clone();
                    for &i in &ordered {
                        let mut low = quantities[i];
                        let mut high = remaining[i];
                        let mut step = 1usize;
                        let area = validation::polygon(&job.parts[i].outer).unsigned_area();
                        high = high.min(
                            ((stock.width_mm * stock.length_mm / area).floor() as usize)
                                .saturating_add(1),
                        );
                        while low < high && !stopped() {
                            let batch = low.saturating_add(step).min(high);
                            let mut trial = quantities.clone();
                            trial[i] = batch;
                            let budget =
                                insertion_budget_ms(&job.settings, current.is_some(), deadline);
                            let mut child_trial = child.clone();
                            for (p, n) in child_trial.parts.iter_mut().zip(&trial) {
                                p.quantity = *n;
                            }
                            let mut offered = None;
                            let candidate = if let Some(k) = &mut kernel {
                                k.step(&json!({"quantities":trial,"mode":"search","budget_ms":budget,"initial_snapshot":snapshot,"retain_snapshot":snapshot}),seed.wrapping_add(round).wrapping_add(batch as u64),revision,cancel,&mut |event|{if event["type"]=="candidate"{offered=event["snapshotId"].as_u64();}}).ok()
                            } else {
                                polygon::run(
                                    &child_trial,
                                    current.as_ref(),
                                    seed.wrapping_add(round),
                                    revision,
                                    budget,
                                    &stopped,
                                )
                            };
                            if let Some(result) = candidate
                                && result["validation"]["status"] == "passed"
                            {
                                quantities = trial;
                                snapshot = result["snapshotId"].as_u64();
                                current = Some(result);
                                low = batch;
                                step = step.saturating_mul(2);
                                let mut next = entries.clone();
                                next.push(json!({"job":child_trial,"result":current}));
                                let pending = remaining
                                    .iter()
                                    .zip(&quantities)
                                    .map(|(a, b)| a - b)
                                    .collect::<Vec<_>>();
                                let value =
                                    aggregate(&job, &next, &pending, seed, revision, started);
                                send(
                                    json!({"type":"current-round","roundIndex":round,"result":value}),
                                );
                                if value["validation"]["status"] == "passed"
                                    && compare_score(&job, &value, &best).is_lt()
                                {
                                    best = value;
                                    send(json!({"type":"candidate","result":best}));
                                }
                                continue;
                            }
                            high = batch - 1;
                            step = (step / 2).max(1);
                        }
                    }
                    if quantities == remaining && final_compression_deadline.is_none() {
                        let end = Instant::now()
                            + Duration::from_secs(
                                u64::from(job.settings.sheet_compression_seconds.unwrap_or(10))
                                    * u64::from(failures),
                            );
                        final_compression_deadline = Some(deadline.unwrap_or(end));
                    }
                    if let (Some(k), Some(id), Some(result)) =
                        (&mut kernel, snapshot, current.as_ref())
                    {
                        if stopped() {
                            break;
                        }
                        send(
                            json!({"type":"progress","phase":"Compression","roundIndex":round,"sheetIndex":entries.len(),"insertionFailures":pass}),
                        );
                        let budget =
                            job.settings.sheet_compression_seconds.unwrap_or(10) as f64 * 1000.0;
                        let budget = budget.min(deadline.map_or(budget, |d| {
                            d.saturating_duration_since(Instant::now()).as_secs_f64() * 1000.0
                        }));
                        let budget = budget.min(final_compression_deadline.map_or(budget, |d| {
                            d.saturating_duration_since(Instant::now()).as_secs_f64() * 1000.0
                        }));
                        let mut id_new = None;
                        let compressed=k.step(&json!({"quantities":quantities,"mode":"compress","initial_snapshot":id,"retain_snapshot":id,"budget_ms":budget}),seed.wrapping_add(round),revision,cancel,&mut |event|{if event["type"]=="candidate"{id_new=event["snapshotId"].as_u64();}}).ok();
                        if let Some(c) = compressed
                            && c["usedLengthMm"].as_f64() <= result["usedLengthMm"].as_f64()
                        {
                            snapshot = c["snapshotId"].as_u64();
                            current = Some(c);
                        }
                    }
                    if kernel.is_none()
                        && let Some(result) = current.as_ref()
                    {
                        let mut compression_job = child.clone();
                        for (p, n) in compression_job.parts.iter_mut().zip(&quantities) {
                            p.quantity = *n;
                        }
                        let budget =
                            f64::from(job.settings.sheet_compression_seconds.unwrap_or(10))
                                * 1000.0;
                        let end = final_compression_deadline.or(deadline);
                        let budget = budget.min(end.map_or(budget, |d| {
                            d.saturating_duration_since(Instant::now()).as_secs_f64() * 1000.0
                        }));
                        if let Some(candidate) = polygon::run(
                            &compression_job,
                            Some(result),
                            seed.wrapping_add(round),
                            revision,
                            budget,
                            &stopped,
                        ) && candidate["usedLengthMm"].as_f64()
                            <= result["usedLengthMm"].as_f64()
                        {
                            current = Some(candidate);
                        }
                    }
                    if quantities == remaining {
                        if let Some(result) = current.as_ref() {
                            let mut current_job = child.clone();
                            for (part, quantity) in current_job.parts.iter_mut().zip(&quantities) {
                                part.quantity = *quantity;
                            }
                            let mut next = entries.clone();
                            next.push(json!({"job":current_job,"result":result}));
                            let pending = remaining
                                .iter()
                                .zip(&quantities)
                                .map(|(a, b)| a - b)
                                .collect::<Vec<_>>();
                            let value = aggregate(&job, &next, &pending, seed, revision, started);
                            if value["validation"]["status"] == "passed" {
                                send(
                                    json!({"type":"current-round","roundIndex":round,"result":value}),
                                );
                                if compare_score(&job, &value, &best).is_lt() {
                                    best = value;
                                    send(json!({"type":"candidate","result":best}));
                                }
                            }
                        }
                        if let Some(end) = final_compression_deadline {
                            if Instant::now() >= end {
                                break;
                            }
                            std::thread::sleep(
                                Duration::from_millis(100)
                                    .min(end.saturating_duration_since(Instant::now())),
                            );
                        }
                        continue;
                    }
                    if initial_pass {
                        initial_pass = false;
                    } else {
                        pass = if before == quantities { pass + 1 } else { 0 };
                        if pass >= failures {
                            break;
                        }
                    }
                    if current.is_none() {
                        break;
                    }
                }
                if current.is_none() {
                    *failed_stocks.entry(stock.id.clone()).or_default() += 1;
                } else {
                    failed_stocks.remove(&stock.id);
                }
                if let Some(result) = current {
                    for (p, n) in child.parts.iter_mut().zip(&quantities) {
                        p.quantity = *n;
                    }
                    for (n, q) in remaining.iter_mut().zip(&quantities) {
                        *n -= q;
                    }
                    entries.push(json!({"job":child,"result":result}));
                    let value = aggregate(&job, &entries, &remaining, seed, revision, started);
                    if value["validation"]["status"] == "passed"
                        && compare_score(&job, &value, &best).is_lt()
                    {
                        best = value;
                        send(json!({"type":"candidate","result":best}));
                    }
                }
            }
        }
        if remaining.iter().all(|n| *n == 0) {
            break;
        }
        stagnant = if compare_score(&job, &best, &previous).is_eq() {
            stagnant + 1
        } else {
            0
        };
        if deadline.is_none() && stagnant >= 3 {
            break;
        }
        round += 1;
    }
    best["elapsedSeconds"] = json!(started.elapsed().as_secs_f64());
    best["reason"] = json!(
        if cancel.is_some_and(|c| c.requested.load(Ordering::Relaxed)) {
            "Stopped"
        } else if best["unplaced"].as_array().unwrap().is_empty() || deadline.is_some() {
            "Complete"
        } else if !job.settings.auto_add_sheets
            && best["sheets"].as_array().unwrap().len()
                >= inventory.iter().map(|s| s.quantity).sum()
        {
            "StockExhausted"
        } else {
            "Unplaceable"
        }
    );
    best["cancelled"] = json!(cancel.is_some_and(|c| c.requested.load(Ordering::Relaxed)));
    send(json!({"type":"finished","result":best}));
    Ok(best)
}

#[allow(dead_code)]
fn polygon_attempt_legacy(
    job: &Job,
    initial: Option<&Value>,
    seed: u64,
    revision: u32,
    stopped: &dyn Fn() -> bool,
) -> Option<Value> {
    let stock = stocks(job).into_iter().next()?;
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
    let mut placements = initial
        .and_then(|v| v["placements"].as_array())
        .cloned()
        .unwrap_or_default();
    let mut rings = placements
        .iter()
        .map(|p| {
            let part = job
                .parts
                .iter()
                .find(|part| part.id == p["partId"].as_str().unwrap())
                .unwrap();
            validation::transform(
                &part.outer,
                p["xMm"].as_f64().unwrap(),
                p["yMm"].as_f64().unwrap(),
                p["angleDeg"].as_f64().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    for part in &job.parts {
        for copy in 0..part.quantity {
            if stopped() {
                return None;
            }
            if placements
                .iter()
                .any(|p| p["partId"] == part.id && p["copyIndex"] == copy)
            {
                continue;
            }
            let angles = match &part.rotations {
                Rotations::Discrete { degrees } => degrees.clone(),
                Rotations::Continuous => (0..72).map(|i| f64::from(i) * 5.0).collect(),
            };
            let mut chosen: Option<(Value, Ring, f64, f64)> = None;
            for angle in angles {
                let rotated = validation::transform(&part.outer, 0.0, 0.0, angle);
                let bbox = validation::polygon(&rotated).bounding_rect()?;
                let mut candidates = Vec::new();
                let anchors = outer
                    .iter()
                    .chain(holes.iter().flatten())
                    .chain(rings.iter().flatten())
                    .collect::<Vec<_>>();
                for target in anchors.iter().step_by((anchors.len() / 96).max(1)) {
                    for vertex in rotated.iter().step_by((rotated.len() / 96).max(1)) {
                        let x = target[0] - vertex[0];
                        let y = target[1] - vertex[1];
                        candidates.push((x, y));
                        let gap = job.settings.clearance_mm;
                        for (dx, dy) in [(gap, 0.0), (-gap, 0.0), (0.0, gap), (0.0, -gap)] {
                            candidates.push((x + dx, y + dy));
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
                        return None;
                    }
                    let ring = validation::transform(&part.outer, x, y, angle);
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
                    if chosen.as_ref().is_none_or(|(_, _, bx, by)| {
                        b.max().x < *bx - 1e-6
                            || ((b.max().x - bx).abs() <= 1e-6 && b.min().y < *by)
                    }) {
                        chosen = Some((
                            json!({"partId":part.id,"copyIndex":copy,"xMm":x,"yMm":y,"angleDeg":angle}),
                            ring,
                            b.max().x,
                            b.min().y,
                        ));
                    }
                    break;
                }
            }
            let (p, r, _, _) = chosen?;
            placements.push(p);
            rings.push(r);
        }
    }
    let used = rings
        .iter()
        .map(|r| validation::polygon(r).bounding_rect().unwrap().max().x)
        .fold(0.0, f64::max);
    let mut result = json!({"documentRevision":revision,"solverRevision":SOLVER_REVISION,"seed":seed.to_string(),"elapsedSeconds":0,"usedLengthMm":used,"placements":placements});
    result["validation"] = validation::check(job, &result);
    (result["validation"]["status"] == "passed").then_some(result)
}
