# Local Sparrow static-stock fork

Baseline: Sparrow `7f0e10f946f70a86138d3938548a13ee46464f39` (MIT), Jagua `0.8.3` (MPL-2.0).

The source used by the WASM builds is maintained in `vendor/sparrow` and `vendor/jagua-rs`; Cargo uses path dependencies rather than modifying the user's Cargo cache. Preserve both upstream license texts. Distributing a binary containing the modified Jagua requires offering the corresponding modified covered source under MPL-2.0, not only an upstream download link. The notices generator identifies these local sources; public deployment still requires making that source actually accessible.

The optional solver JSON field `stock_geometry` contains normalized stock `outer` and `holes` rings. The WASM bridge computes the union of the outer bounding rectangle's complement and stock holes, decomposing any regions with inner rings into simple polygons. Those polygons become immutable quality-zero container hazards, never product items. Product IDs, demand, result counts and exports remain unchanged.

The Jagua instance carries a shared immutable constraint set and maximum stock length. Initial construction uses the full stock length; width changes and restores recreate the same static hazards in their original coordinates. Cross-stock snapshots are rejected. The quadtree classifies root-outside and root-covering hazards without losing their entity identities.

Sparrow's evaluator, tracker and debug assertions include static-hole polygon collision losses in the per-item container loss and guided-local-search weight. Exploration and compression move only product placements. No obstacle is exposed as a movable product. The frontend still independently validates complete product geometry against the actual stock domain before accepting candidates.

## Clearance and fallback

Ordinary strip behavior is preserved. Product geometry retains Sparrow's half-gap inflation, and the rectangular outer container retains its existing edge inset. Static forbidden regions are not additionally inflated, avoiding inflation of decomposition seams. This can still be conservative near stock boundaries; it does not introduce a configurable stock-edge margin. When the requested gap is at least the stock width, the existing geometry-aware fallback remains in use instead of sending an invalid inset container to Sparrow.

## WASM worker stack and repeated restore

Rayon WASM worker initialization explicitly requests an 8 MiB linear-memory stack (wasm-bindgen's default is 2 MiB). This is separate from linker stack settings for the root instance. The actual `circle sheet.dxf` / `_6.dxf` demand-30 fixture intermittently failed with a memory trap in `compute_pole` during `SeparatorWorker::load` and `SPProblem::restore`. Stack-enabled comparisons completed 12 consecutive runs, including a captured failure seed; this supports the worker-stack diagnosis but is not a proof against all future memory failures.

Same-strip snapshot restore no longer constructs and discards a new static container. A native counter-based regression verifies zero factory calls for same-strip restores and one call after a width change. Worker error messages preserve exception stacks. `app/tests/rayon-worker.test.ts` verifies the initialization size and diagnostic stack forwarding. The original DXFs and generated solver fixture are retained under `test/` for native and import regression tests.

## Verification

- `cargo +stable test --manifest-path vendor/jagua-rs/Cargo.toml --lib --features spp --offline`
- `cargo +stable test --manifest-path vendor/sparrow/Cargo.toml --lib --offline`
- `cargo +nightly-2026-08-30 test --manifest-path vendor/sparrow/Cargo.toml --lib --offline --features simd`
- `cargo +stable test --manifest-path web/wasm/Cargo.toml --lib --offline`
- `cargo +nightly-2026-08-30 test --manifest-path web/wasm/Cargo.toml --lib --features sparrow/simd --offline`
- From `app/`: `npm run wasm:build`, `npm run typecheck`, `npm test`, `npm run build`.
- `node web/scripts/generate-notices.mjs --check`

The tests cover static collision loss, weighted/bounded evaluation, resize/restore, root-outside/covering hazards, finite stock construction, and complete exploration/compression with one and three workers on concave/holed stock. They do not prove global optimality or manufacturing suitability.
