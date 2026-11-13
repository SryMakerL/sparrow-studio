//! Native C ABI. Callers own pointer validity and cancellation-handle lifetime.
//! Returned strings belong to Rust and must only be released by sparrow_string_free.
use geo::{Area, Contains, Intersects, LineString, Polygon, Validation};
use jagua_rs::{
    Instant,
    io::import::Importer,
    probs::spp::{
        entities::{SPInstance, SPSolution},
        io::{export, ext_repr::ExtSPInstance, import_instance},
    },
};
use rand::{SeedableRng, rngs::Xoshiro256PlusPlus};
use serde::{Deserialize, Serialize};

mod abi;
#[cfg(test)]
mod auto_sheet_tests;
mod compression;
#[cfg(test)]
mod extended_tests;
mod kernel;
#[cfg(test)]
mod native_tests;
#[cfg(test)]
mod parity_tests;
mod polygon;
mod sheets;
mod validation;
use serde_json::{Value, json};
use sparrow::{
    config::{DEFAULT_SPARROW_CONFIG, ShrinkDecayStrategy, SparrowConfig},
    consts::{DEFAULT_FAIL_DECAY_RATIO_CMPR, DEFAULT_MAX_CONSEQ_FAILS_EXPL},
    optimizer::optimize,
    util::{
        listener::{ReportType, SolutionListener},
        terminator::{BasicTerminator, Terminator},
    },
};
use std::{
    collections::HashSet,
    ffi::{CString, c_char},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

#[allow(clippy::items_after_test_module)]
#[path = "../../../web/wasm/src/stock.rs"]
mod stock;
#[path = "../../../web/wasm/src/warm_start.rs"]
mod warm_start;

const MAX_JSON: usize = 10 * 1024 * 1024;
const SOLVER_REVISION: &str = "7f0e10f946f70a86138d3938548a13ee46464f39+studio-static-stock-1";
type Ring = Vec<[f64; 2]>;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    name: String,
    parts: Vec<Part>,
    settings: Settings,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Part {
    id: String,
    name: String,
    source: Source,
    outer: Ring,
    holes: Vec<Ring>,
    approximation_tolerance_mm: f64,
    quantity: usize,
    #[serde(default)]
    priority: i32,
    rotations: Rotations,
}
#[derive(Clone, Deserialize, Serialize)]
struct Source {
    format: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Rotations {
    Continuous,
    Discrete { degrees: Vec<f64> },
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    material_width_mm: f64,
    clearance_mm: f64,
    time_limit_seconds: Option<u32>,
    solver_preset: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sheet_length_mm: Option<f64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    auto_add_sheets: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    sheet_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sheet_stock: Option<SheetStock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sheet_stocks: Option<Vec<SheetStock>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sheet_insertion_warm_start_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sheet_initial_search_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sheet_compression_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sheet_insertion_failures: Option<u32>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SheetStock {
    id: String,
    name: String,
    quantity: usize,
    priority: i32,
    width_mm: f64,
    length_mm: f64,
    #[serde(flatten)]
    shape: StockShape,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum StockShape {
    Rectangle,
    Polygon {
        outer: Ring,
        holes: Vec<Ring>,
        #[serde(rename = "approximationToleranceMm")]
        approximation_tolerance_mm: Option<f64>,
    },
}

/// Opaque cancellation token. Concurrent requests are safe; freeing during solve is not.
pub struct Cancel {
    requested: AtomicBool,
}
#[unsafe(no_mangle)]
pub extern "C" fn sparrow_cancel_create() -> *mut Cancel {
    catch_unwind(|| {
        Box::into_raw(Box::new(Cancel {
            requested: AtomicBool::new(false),
        }))
    })
    .unwrap_or(std::ptr::null_mut())
}
/// # Safety
/// `ptr` must be null or a live handle returned by sparrow_cancel_create.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sparrow_cancel_request(ptr: *mut Cancel) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if let Some(token) = unsafe { ptr.as_ref() } {
            token.requested.store(true, Ordering::Relaxed);
        }
    }));
}
/// # Safety
/// Free once only, after every solve/request using this handle has completed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sparrow_cancel_free(ptr: *mut Cancel) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !ptr.is_null() {
            drop(unsafe { Box::from_raw(ptr) });
        }
    }));
}
/// # Safety
/// Input must be readable through its NUL terminator (at most MAX_JSON+1 bytes).
/// Cancel must be null or remain live throughout this synchronous call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sparrow_solve_json(
    input_utf8: *const c_char,
    seed: u64,
    revision: u32,
    cancel: *const Cancel,
) -> *mut c_char {
    let response = catch_unwind(AssertUnwindSafe(|| -> Result<Value, String> {
        if input_utf8.is_null() {
            return Err("Input pointer is null".into());
        }
        let mut len = 0;
        while len <= MAX_JSON && unsafe { *input_utf8.add(len) } != 0 {
            len += 1;
        }
        if len > MAX_JSON {
            return Err("Input exceeds 10 MiB".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(input_utf8.cast::<u8>(), len) };
        let input = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
        solve(input, seed, revision, unsafe { cancel.as_ref() })
    }));
    let envelope = match response {
        Ok(Ok(result)) => json!({"ok": true, "result": result}),
        Ok(Err(error)) => json!({"ok": false, "error": error}),
        Err(_) => json!({"ok": false, "error": "Native solver panicked"}),
    };
    CString::new(envelope.to_string())
        .expect("JSON escapes NUL")
        .into_raw()
}
/// # Safety
/// `ptr` must be null or an unfreed string returned by sparrow_solve_json.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sparrow_string_free(ptr: *mut c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !ptr.is_null() {
            drop(unsafe { CString::from_raw(ptr) });
        }
    }));
}

struct NativeTerminator<'a> {
    cancel: Option<&'a Cancel>,
    timed: bool,
    inner: BasicTerminator,
}
impl NativeTerminator<'_> {
    fn cancelled(&self) -> bool {
        self.cancel
            .is_some_and(|c| c.requested.load(Ordering::Relaxed))
    }
}
impl Terminator for NativeTerminator<'_> {
    fn kill(&self) -> bool {
        self.cancelled() || self.inner.kill()
    }
    fn new_timeout(&mut self, timeout: Duration) {
        if self.timed {
            self.inner.new_timeout(timeout);
        }
    }
    fn timeout_at(&self) -> Option<Instant> {
        self.inner.timeout_at()
    }
}
struct Listener;
impl SolutionListener for Listener {
    fn report(&mut self, _: ReportType, _: &SPSolution, _: &SPInstance) {}
}

fn positive(v: f64) -> bool {
    v.is_finite() && v > 0.0 && v <= 100_000.0 && (v as f32) > 0.0
}
fn tolerance(v: f64) -> bool {
    v.is_finite() && (0.0..=100.0).contains(&v)
}
fn ring(points: &Ring) -> Result<Polygon<f64>, String> {
    let mut p = points.clone();
    if p.len() > 1 && p.first() == p.last() {
        p.pop();
    }
    if p.len() < 3
        || p.iter()
            .flatten()
            .any(|v| !v.is_finite() || v.abs() > 100_000.0)
    {
        return Err("Contours require at least 3 finite vertices within 100000 mm".into());
    }
    let original = Polygon::new(
        LineString::from(p.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>()),
        vec![],
    );
    if !original.is_valid() || original.unsigned_area() <= 1e-10 {
        return Err("Contour must be simple and nondegenerate".into());
    }
    // Validate in the precision actually consumed by jagua, not just JSON f64.
    let p: Vec<_> = p
        .iter()
        .map(|p| (f64::from(p[0] as f32), f64::from(p[1] as f32)))
        .collect();
    let poly = Polygon::new(LineString::from(p), vec![]);
    if !poly.is_valid()
        || poly.unsigned_area() <= 1e-10
        || poly.exterior().0.windows(2).any(|p| p[0] == p[1])
    {
        return Err("Contour must be simple and nondegenerate at solver precision".into());
    }
    Ok(poly)
}
fn geometry(outer: &Ring, holes: &[Ring]) -> Result<(), String> {
    if holes.len() > 500 {
        return Err("Geometry exceeds 500 holes".into());
    }
    let original = Polygon::new(
        LineString::from(outer.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>()),
        holes
            .iter()
            .map(|h| LineString::from(h.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>()))
            .collect(),
    );
    if !original.is_valid() {
        return Err("Invalid original polygon or hole topology".into());
    }
    let outer = ring(outer)?;
    let mut previous = Vec::<Polygon<f64>>::new();
    for hole in holes {
        let hole = ring(hole)?;
        if !outer.contains(&hole)
            || outer.exterior().intersects(hole.exterior())
            || previous.iter().any(|p| p.intersects(&hole))
        {
            return Err("Holes must be strictly inside outer and mutually disjoint".into());
        }
        previous.push(hole);
    }
    Ok(())
}
fn validate(job: &Job) -> Result<(), String> {
    let s = &job.settings;
    sheets::validate_stocks(job)?;
    if job.name.trim().is_empty() || job.parts.is_empty() {
        return Err("Job requires a name and at least one part type".into());
    }
    if !positive(s.material_width_mm)
        || !s.clearance_mm.is_finite()
        || s.clearance_mm < 0.0
        || (s.clearance_mm > 0.0 && (s.clearance_mm as f32) == 0.0)
        || (s.sheet_length_mm.is_none()
            && s.sheet_stocks.is_none()
            && (s.clearance_mm as f32) >= (s.material_width_mm as f32))
        || s.sheet_length_mm.is_some_and(|v| !positive(v))
        || !matches!(s.time_limit_seconds, None | Some(1..=600))
        || !matches!(s.solver_preset.as_str(), "standard" | "fast")
        || s.sheet_count
            .is_some_and(|v| v == 0 || s.sheet_length_mm.is_none())
        || s.sheet_insertion_warm_start_seconds
            .is_some_and(|v| !(1..=600).contains(&v))
        || s.sheet_initial_search_seconds
            .is_some_and(|v| !v.is_finite() || !(0.1..=600.0).contains(&v))
        || s.sheet_compression_seconds
            .is_some_and(|v| !(1..=600).contains(&v))
        || s.sheet_insertion_failures
            .is_some_and(|v| !(1..=100).contains(&v))
    {
        return Err("Invalid settings, dimensions, clearance, duration or preset".into());
    }
    let mut ids = HashSet::new();
    for part in &job.parts {
        if part.id.is_empty()
            || !ids.insert(&part.id)
            || part.name.len() > MAX_JSON
            || !matches!(part.source.format.as_str(), "svg" | "dxf" | "sparrow")
            || part.priority < 0
            || !tolerance(part.approximation_tolerance_mm)
        {
            return Err("Invalid part identity, source, priority or tolerance".into());
        }
        if let Rotations::Discrete { degrees } = &part.rotations
            && (degrees.is_empty()
                || degrees.len() > 5000
                || degrees
                    .iter()
                    .any(|v| !v.is_finite() || !(*v as f32).is_finite()))
        {
            return Err(
                "Discrete rotations require 1..5000 finite solver-representable degrees".into(),
            );
        }
        geometry(&part.outer, &part.holes)?;
    }
    if !job.parts.iter().any(|part| part.quantity > 0) {
        return Err("Job has no demanded parts".into());
    }
    if let Some(stock) = &s.sheet_stock {
        if stock.id.is_empty()
            || stock.name.len() > MAX_JSON
            || stock.quantity == 0
            || stock.priority < 0
            || !positive(stock.width_mm)
            || !positive(stock.length_mm)
            || stock.width_mm != s.material_width_mm
            || Some(stock.length_mm) != s.sheet_length_mm
        {
            return Err("Invalid single stock or mismatched snapshot dimensions".into());
        }
        if let StockShape::Polygon {
            outer,
            holes,
            approximation_tolerance_mm,
        } = &stock.shape
        {
            geometry(outer, holes)?;
            if approximation_tolerance_mm.is_some_and(|v| !tolerance(v))
                || outer.iter().chain(holes.iter().flatten()).any(|p| {
                    p[0] < 0.0 || p[0] > stock.length_mm || p[1] < 0.0 || p[1] > stock.width_mm
                })
            {
                return Err("Stock geometry lies outside declared dimensions".into());
            }
            let xmax = outer.iter().map(|p| p[0]).fold(0.0, f64::max);
            if (xmax - stock.length_mm).abs() > 1e-4 {
                return Err("Stock outer extent must match length".into());
            }
        }
    }
    Ok(())
}

fn solver_config(preset: &str, seconds: Option<u32>) -> SparrowConfig {
    let mut config = DEFAULT_SPARROW_CONFIG;
    config.expl_cfg.max_conseq_failed_attempts = Some(DEFAULT_MAX_CONSEQ_FAILS_EXPL);
    config.cmpr_cfg.shrink_decay = ShrinkDecayStrategy::FailureBased(DEFAULT_FAIL_DECAY_RATIO_CMPR);
    if preset == "fast" {
        config.expl_cfg.shrink_step = 0.01;
        config.expl_cfg.max_conseq_failed_attempts = Some(10);
        config.expl_cfg.separator_config.iter_no_imprv_limit = 50;
        config.expl_cfg.separator_config.strike_limit = 2;
        config.cmpr_cfg.shrink_range = (0.0005, 0.0001);
        config.cmpr_cfg.shrink_decay = ShrinkDecayStrategy::FailureBased(0.9);
        config.cmpr_cfg.separator_config.iter_no_imprv_limit = 50;
        config.cmpr_cfg.separator_config.strike_limit = 2;
        config.cde_config.cd_threshold = 16;
    }
    config.expl_cfg.separator_config.n_workers = 1;
    config.cmpr_cfg.separator_config.n_workers = 1;
    if let Some(seconds) = seconds {
        config.expl_cfg.time_limit = Duration::from_secs_f64(f64::from(seconds) * 0.8);
        config.cmpr_cfg.time_limit = Duration::from_secs_f64(f64::from(seconds) * 0.2);
    }
    config
}

fn solve(input: &str, seed: u64, revision: u32, cancel: Option<&Cancel>) -> Result<Value, String> {
    sheets::run(input, seed, revision, cancel, &mut |_| {})
}

#[allow(dead_code)]
fn solve_legacy(
    input: &str,
    seed: u64,
    revision: u32,
    cancel: Option<&Cancel>,
) -> Result<Value, String> {
    let started = Instant::now();
    if input.len() > MAX_JSON {
        return Err("Input exceeds 10 MiB".into());
    }
    let job: Job = serde_json::from_str(input).map_err(|e| format!("Invalid Job JSON: {e}"))?;
    let mut terminator = NativeTerminator {
        cancel,
        timed: job.settings.time_limit_seconds.is_some(),
        inner: BasicTerminator::new(),
    };
    if terminator.cancelled() {
        return Err("cancelled".into());
    }
    validate(&job)?;
    let parts: Vec<_> = job.parts.iter().filter(|p| p.quantity > 0).collect();
    let items: Vec<_> = parts.iter().enumerate().map(|(id,p)| json!({"id": id, "demand": p.quantity, "priority": p.priority, "allowed_orientations": match &p.rotations { Rotations::Continuous => None, Rotations::Discrete { degrees } => Some(degrees.iter().map(|v| v.rem_euclid(360.0)).collect::<Vec<_>>()) }, "shape": {"type": "simple_polygon", "data": p.outer}})).collect();
    let mut external = json!({"name": job.name, "strip_height": job.settings.material_width_mm, "items": items, "stock_length": job.settings.sheet_length_mm});
    if let Some(SheetStock {
        shape: StockShape::Polygon { outer, holes, .. },
        ..
    }) = &job.settings.sheet_stock
    {
        external["stock_geometry"] = json!({"outer": outer, "holes": holes});
    }
    let text = external.to_string();
    let external: ExtSPInstance = serde_json::from_value(external).map_err(|e| e.to_string())?;
    let mut config = solver_config(&job.settings.solver_preset, job.settings.time_limit_seconds);
    config.min_item_separation =
        (job.settings.clearance_mm > 0.0).then_some(job.settings.clearance_mm as f32);
    let importer = Importer::new(
        config.cde_config,
        config.poly_simpl_tolerance,
        config.min_item_separation,
        config.narrow_concavity_cutoff_ratio,
    );
    let instance = import_instance(&importer, &external).map_err(|e| e.to_string())?;
    let instance = stock::apply(instance, stock::parse(&text, external.strip_height)?)?;
    let warm = warm_start::parse(&text)?;
    let instance = warm_start::apply_stock_length(instance, &warm)?;
    let initial = warm_start::construct(&instance, &warm, Xoshiro256PlusPlus::seed_from_u64(seed))?;
    if terminator.cancelled() {
        return Err("cancelled".into());
    }
    let solution = optimize(
        instance.clone(),
        Xoshiro256PlusPlus::seed_from_u64(seed),
        &mut Listener,
        &mut terminator,
        &config.expl_cfg,
        &config.cmpr_cfg,
        initial.as_ref(),
    )
    .map_err(|e| format!("No feasible initial placement for item {}", e.item_id))?;
    if terminator.cancelled() {
        return Err("cancelled".into());
    }
    let out = export(&instance, &solution, started);
    let mut counts = vec![0; parts.len()];
    let mut placements = Vec::new();
    for p in out.layout.placed_items {
        let id = p.item_id as usize;
        let part = parts.get(id).ok_or("Solver returned unknown item")?;
        if counts[id] >= part.quantity {
            return Err("Solver returned duplicate excess copy".into());
        }
        let transform = serde_json::to_value(p.transformation).map_err(|e| e.to_string())?;
        let x = transform["translation"][0]
            .as_f64()
            .ok_or("Nonfinite solver translation")?;
        let y = transform["translation"][1]
            .as_f64()
            .ok_or("Nonfinite solver translation")?;
        let angle = transform["rotation"]
            .as_f64()
            .ok_or("Nonfinite solver rotation")?;
        placements.push(json!({"partId": part.id, "copyIndex": counts[id], "xMm": x, "yMm": y, "angleDeg": angle}));
        counts[id] += 1;
    }
    if !out.strip_width.is_finite()
        || out.strip_width <= 0.0
        || counts.iter().zip(&parts).any(|(n, p)| *n != p.quantity)
    {
        return Err("Solver did not produce a complete finite layout".into());
    }
    Ok(
        json!({"documentRevision": revision, "solverRevision": SOLVER_REVISION, "seed": seed.to_string(), "elapsedSeconds": started.elapsed().as_secs_f64(), "usedLengthMm": out.strip_width, "placements": placements, "validation": {"status": "pending", "overlapAreaMm2": null, "maxBoundaryViolationMm": null, "minClearanceMm": null, "errors": []}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job() -> Value {
        json!({"name":"rectangle","parts":[{"id":"part-a","name":"A","source":{"format":"svg"},"outer":[[0,0],[10,0],[10,10],[0,10]],"holes":[],"approximationToleranceMm":0,"quantity":2,"priority":3,"rotations":{"kind":"discrete","degrees":[0,90]}}],"settings":{"materialWidthMm":40,"clearanceMm":1,"timeLimitSeconds":null,"solverPreset":"fast"}})
    }
    #[test]
    fn rectangle_solve() {
        let result = solve(&job().to_string(), 42, 7, None).unwrap();
        assert_eq!(result["validation"]["status"], "passed");
        assert_eq!(result["documentRevision"], 7);
        assert_eq!(result["seed"], "42");
        assert_eq!(result["placements"].as_array().unwrap().len(), 2);
        let mut copies: Vec<_> = result["placements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                assert_eq!(p["partId"], "part-a");
                p["copyIndex"].as_u64().unwrap()
            })
            .collect();
        copies.sort();
        assert_eq!(copies, vec![0, 1]);
    }
    #[test]
    fn rejects_invalid() {
        for bad in ["null", "{}", "{\"name\":NaN}"] {
            assert!(solve(bad, 0, 0, None).is_err());
        }
        let mut j = job();
        j["parts"][0]["outer"] = json!([[0, 0], [10, 10], [0, 10], [10, 0]]);
        assert!(solve(&j.to_string(), 0, 0, None).is_err());
        let mut j = job();
        j["settings"]["sheetCount"] = json!(2);
        assert!(solve(&j.to_string(), 0, 0, None).is_err());
    }
    #[test]
    fn finite_stock_and_conservative_holes() {
        for polygon in [false, true] {
            let mut j = job();
            j["settings"]["sheetLengthMm"] = json!(80);
            // No sheetCount: this is a finite single-sheet solve, not an aggregate.
            if polygon {
                j["settings"]["sheetStock"] = json!({"id":"board","name":"Board","quantity":1,"priority":0,"widthMm":40,"lengthMm":80,"kind":"polygon","outer":[[0,0],[80,0],[80,30],[60,40],[0,40]],"holes":[[[40,10],[50,10],[50,20],[40,20]]]});
            }
            j["parts"][0]["holes"] = json!([[[2, 2], [8, 2], [8, 8], [2, 8]]]);
            let r = solve(&j.to_string(), 42, 0, None).unwrap();
            assert!(r["usedLengthMm"].as_f64().unwrap() <= 80.0);
            assert_eq!(r["placements"].as_array().unwrap().len(), 2);
        }
    }
    #[test]
    fn rejects_limits_and_invalid_geometry() {
        for (path, value) in [
            ("materialWidthMm", json!(0)),
            ("clearanceMm", json!(-1)),
            ("sheetStocks", json!([])),
            ("timeLimitSeconds", json!(0)),
        ] {
            let mut j = job();
            j["settings"][path] = value;
            assert!(solve(&j.to_string(), 0, 0, None).is_err(), "{path}");
        }
        for quantity in [json!(-1), json!(1.5), json!(1e100), json!("501")] {
            let mut j = job();
            j["parts"][0]["quantity"] = quantity;
            assert!(serde_json::from_value::<Job>(j).is_err());
        }
        let mut j = job();
        j["parts"][0]["quantity"] = json!(0);
        assert!(validate(&serde_json::from_value(j).unwrap()).is_err());
        let mut j = job();
        j["parts"][0]["holes"] = json!([[[20, 20], [21, 20], [21, 21], [20, 21]]]);
        assert!(solve(&j.to_string(), 0, 0, None).is_err());
        let mut j = job();
        j["parts"][0]["outer"] = json!([[0, 0], [1e100, 0], [1, 1]]);
        assert!(solve(&j.to_string(), 0, 0, None).is_err());
        let mut j = job();
        j["parts"][0]["outer"] = json!([
            [10000, 0],
            [10000.0000001, 0],
            [10000.0000001, 1],
            [10000, 1]
        ]);
        assert!(solve(&j.to_string(), 0, 0, None).is_err());
    }
    #[test]
    fn accepts_large_demands_without_solving() {
        for quantity in [501, 1_000_000, usize::MAX] {
            let mut j = job();
            j["parts"][0]["quantity"] = json!(quantity);
            let mut second = j["parts"][0].clone();
            second["id"] = json!("part-b");
            j["parts"].as_array_mut().unwrap().push(second);
            assert!(validate(&serde_json::from_value(j).unwrap()).is_ok());
        }
    }
    #[test]
    fn accepts_more_than_500_part_types() {
        let mut j = job();
        let part = j["parts"][0].clone();
        j["parts"] = Value::Array(
            (0..501)
                .map(|i| {
                    let mut part = part.clone();
                    part["id"] = json!(format!("part-{i}"));
                    part
                })
                .collect(),
        );
        assert!(validate(&serde_json::from_value(j).unwrap()).is_ok());
    }
    #[test]
    fn accepts_more_than_5000_contour_vertices() {
        let mut j = job();
        let outer: Ring = (0..5001)
            .map(|i| {
                let angle = std::f64::consts::TAU * f64::from(i) / 5001.0;
                [20.0 + 10.0 * angle.cos(), 20.0 + 10.0 * angle.sin()]
            })
            .collect();
        j["parts"][0]["outer"] = json!(outer);
        assert!(validate(&serde_json::from_value(j).unwrap()).is_ok());
    }
    #[test]
    fn retains_required_demand_and_geometry_limits() {
        let mut j = job();
        j["parts"] = json!([]);
        assert!(validate(&serde_json::from_value(j).unwrap()).is_err());
        let mut j = job();
        j["name"] = json!("");
        assert!(validate(&serde_json::from_value(j).unwrap()).is_err());
        let mut j = job();
        j["parts"][0]["outer"] = json!([[0, 0], [10, 0]]);
        assert!(validate(&serde_json::from_value(j).unwrap()).is_err());
        let mut j = job();
        j["parts"][0]["holes"] = json!(vec![vec![[2, 2], [3, 2], [3, 3], [2, 3]]; 501]);
        assert!(validate(&serde_json::from_value(j).unwrap()).is_err());
        let mut j = job();
        j["parts"][0]["rotations"]["degrees"] = json!(vec![0; 5001]);
        assert!(validate(&serde_json::from_value(j).unwrap()).is_err());
    }
    #[test]
    fn native_timeout_and_atomic_cancel() {
        let token = Cancel {
            requested: AtomicBool::new(false),
        };
        let mut t = NativeTerminator {
            cancel: Some(&token),
            timed: false,
            inner: BasicTerminator::new(),
        };
        t.new_timeout(Duration::ZERO);
        assert_eq!(t.timeout_at(), None);
        assert!(!t.kill());
        token.requested.store(true, Ordering::Relaxed);
        assert!(t.kill());
        let mut t = NativeTerminator {
            cancel: None,
            timed: true,
            inner: BasicTerminator::new(),
        };
        t.new_timeout(Duration::from_secs(1));
        assert!(t.timeout_at().is_some());
    }
    #[test]
    fn pre_cancelled() {
        let token = Cancel {
            requested: AtomicBool::new(true),
        };
        assert_eq!(
            solve(&job().to_string(), 0, 0, Some(&token)).unwrap_err(),
            "cancelled"
        );
    }
    #[test]
    fn phase_budgets() {
        let c = solver_config("standard", Some(10));
        assert_eq!(c.expl_cfg.time_limit, Duration::from_secs(8));
        assert_eq!(c.cmpr_cfg.time_limit, Duration::from_secs(2));
    }
    #[test]
    fn abi_roundtrip_and_null() {
        unsafe {
            let input = CString::new("{}").unwrap();
            let p = sparrow_solve_json(input.as_ptr(), 0, 0, std::ptr::null());
            let v: Value = serde_json::from_slice(std::ffi::CStr::from_ptr(p).to_bytes()).unwrap();
            assert_eq!(v["ok"], false);
            sparrow_string_free(p);
            let p = sparrow_solve_json(std::ptr::null(), 0, 0, std::ptr::null());
            assert!(!p.is_null());
            sparrow_string_free(p);
            let token = sparrow_cancel_create();
            sparrow_cancel_request(token);
            assert!((*token).requested.load(Ordering::Relaxed));
            sparrow_cancel_free(token);
        }
    }
}
