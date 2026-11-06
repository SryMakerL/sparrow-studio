# sparrow studio (new app)

The new sparrow studio: six tabs that each pair a list with a canvas, several projects in browser storage, and local solving with the open-source sparrow algorithm through WebAssembly. Only implemented local features are shown; no account is required. The current app in `web/` stays as it is until this one launches.

## Running it locally

The solver's WebAssembly builds are shared with `web/`; `web/README.md` lists the Rust toolchains they need. Then:

```bash
cd app
npm install
npm run wasm:build
npm run dev
```

The dev server sends the cross-origin isolation headers, so the solver can use up to 32 threads. Settings offers Automatic or 1–32 threads. Automatic uses `min(32, max(1, hardwareConcurrency - 1))`: it reserves one reported logical core, so 8 logical cores use 7 threads. Without shared memory, the solver falls back to one thread.

## Sheet inventory and priority

In **Sheets**, select **Sheets** instead of **Strip**. Use **Add rectangle** to add different rectangular sizes, or **Import → Sheet contours: DXF…** for irregular stock. Set each stock type's name, dimensions (rectangles), available quantity and priority. Larger priority numbers are attempted first; ties follow inventory list order. Each independent DXF outer contour is a stock type and inner contours may be holes (unavailable material). Preview units and layers before confirming; importing stock does not change the part library. Saved projects retain the inventory and its geometry. Results identify the stock used and export its true outer boundary and holes.

Rectangles and polygon stock use the local Sparrow WASM fork. For polygon stock, the fixed outer-complement and stock holes become static container hazards, not movable parts; Sparrow searches and compresses the product layout while these regions remain fixed through width changes and restores. The frontend still independently validates the real stock domain, holes, collisions and clearance before accepting a result. The narrow-stock case where the requested part gap is at least the stock width retains the geometry-aware fallback to preserve its existing gap semantics. Free rotation in that fallback uses 5-degree samples. This does not guarantee an optimal solution or prove infeasibility when no layout is found. Rectangle selected-sheet utilization retains the used-length denominator; polygon utilization and total stock utilization use actual net usable stock area.

In **Settings → Time and stopping**, choose the total search time for the complete sheet batch and the **Sheet no-improvement timeout, seconds** (whole seconds from 1 to 600, default 15; shown only in sheet mode). Earlier sheets receive priority: each sheet is filled and compressed until its utilization (net part area divided by used length times sheet width) has not improved for the configured timeout. Each genuine utilization improvement resets that timer. After all sheets have been processed, a fresh partition starts from the first sheet. The total Settings deadline and manual Stop override the per-sheet timer, so a short total budget can expire before later sheets are reached. Live shows all validated sheets of the current round together, including partial or worse rounds, and clears that preview at the start of each round. Solution shows all sheets of the best saved round together, with its round number and per-sheet counts, utilization and used length; its sheet selector controls details and downloads without hiding the other sheets. Project storage and exports keep the best round, not the latest preview. The solver keeps searching until the time expires, even if all parts have already been placed. Only improvements replace the best validated plan: fewer unplaced copies first, higher-priority stock use next, fewer sheets next, more copies on earlier sheets next, then a shorter sum of used lengths. Automatic has no fixed total duration and stops after 3 complete rounds without improvement. Stop keeps the best validated plan found so far.

Each physical board owns one persistent worker tree and WASM `SheetSession`. Geometry, stock constraints and internal solution snapshots are imported once and reused across attempts; only demand counts and snapshot IDs cross the boundary after initialization. Validated candidates select the retained snapshot, so rejected candidates and failed insertions cannot replace the incumbent. Normal step completion and cooperative cancellation retain the session; board changes, final Stop and hard timeouts dispose it. A hard timeout may require a fresh session. Compression still rebuilds its temporary optimizer/separator state from the internal snapshot, rather than importing rounded external coordinates. The narrow-stock geometry fallback remains a separate non-WASM path.

When the inventory contains exactly one rectangular board and all original demand has passed independent validation on it, Sheets switches to one continuous optimization call for the remaining total budget. This bypasses the 10-second slice limit and sheet stagnation timer, preserving exploration pools and compression progress within that call. Timed continuous search gives exploration 80% and compression 20% of the available budget; Automatic relies on the optimizer's own stopping rules. Once this final search completes naturally, the job finishes without repartitioning or restarting it. Multiple boards, polygon stock and incomplete demand retain the alternating strategy.

Each board alternates insertion of unplaced copies with compression, prioritizing insertion while copies remain. It first probes one extra copy and grows the batch after success; incremental construction has up to 10 seconds, bounded by the sheet and total deadlines. Both inherit the current best placement; insertion first uses the full available board length, then continues optimization and compression. Existing coordinates are preserved during insertion construction but may move during subsequent optimization. A failed insertion keeps the incumbent and can fall back to a fresh layout search. More placed copies take priority over a shorter used length, and every accepted result still passes independent geometry validation.

This is a sequential heuristic built on the strip solver, not joint multi-bin optimization: it does not guarantee the minimum sheet count. A failed bounded search does not prove that a part or combination is impossible to place. Parts from unfinished attempts remain unplaced. Defects beyond imported stock holes, clamp zones and machine toolpaths are not included.


## Checks

```bash
npm run typecheck
npm test
npm run format:check
npm run build
```

GitHub Actions runs the same checks on every pull request.

`src/engine` keeps the compact style of the code it came from; the rest is formatted with Prettier (`npm run format`).

## Layout

- `src/engine`: solver workers, geometry checks, import and export.
- `src/project`: the project format, the browser project store, preferences and examples.
- `src/ui`: the shell, the six views, dialogs and shared components.
