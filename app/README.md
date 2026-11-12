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

Rectangles and polygon stock use the local Sparrow WASM fork. All boards in a selected combination are joined horizontally into one virtual board without rotating any board. Fixed isolation bands between boards are `max(1 mm, clearance)` wide. The outer-complement of each stock contour and its holes are static container hazards, not movable parts; Sparrow searches all selected boards together while those regions and isolation bands remain fixed during joint search and joint compression. Part rotation still follows the job's rotation rules. Results are split back into physical-board coordinates and independently validated against the real stock domains, holes, collisions and clearance before acceptance. Rectangle selected-sheet utilization retains the used-length denominator; polygon utilization and total stock utilization use actual net usable stock area.

Board-aware sampling is used during initial placement and collision repair: 80% of sampling slots prefer compatible physical-board domains, including bounded contour/hole rejection and some board-edge or neighboring-item hints; 20% retain the original global exploration. Failed domain proposals fall back to the original sampler without increasing the evaluation count. For combinations with at least two boards, exploratory and compression steps are capped by the trailing board's size and available right-edge slack, not just the stitched total length. Failed trials retreat to a smaller step from the last feasible layout; successful trials recover the step gradually. Fixed hazards and final independent validation remain authoritative. Ordinary strips and legacy single-stock inputs retain the original policy.

Multi-board compression alternates warm board-local exploration and compression, global search, and whole-board evacuation under the total search deadline, when configured, and manual Stop. Board-local stages call the original Sparrow warm-start exploration and compression and allow temporary collisions; layouts are published only after mapping back to real boards and passing independent validation. Local passes move only a board's current residents in a translated local Sparrow problem. Prepared part geometry is reused; fixed hazards are clipped and translated with padded walls to retain the original boundary inset and avoid double clearance. Local snapshots are never restored directly into a global problem; accepted placements are inverse-transformed and checked in the original stock constraints. The rightmost occupied physical board is excluded from board-local compaction on every round, including when later selected boards are empty. It still participates in global exploration/compression and whole-board evacuation. Earlier boards are compacted again only when their resident transforms or assignments change. In **Settings → Sheet search budgets** (sheet mode only), configure local compression, global search and board evacuation time slices in whole milliseconds from 1 to 600,000 (defaults: 10000 / 10000 / 3000 ms), and their independent shares of remaining time in whole percentages from 1 to 100 (defaults: 60 / 60 / 25%). Each percentage applies to the remaining total time when that stage starts, capped by its stage time slice. Without a global deadline, stage time caps schedule the search instead. The local allowance is additionally divided among changed boards. Actual board-local time therefore remains limited by the changed-board count, its stage cap and any remaining total time. These are not three shares of one fixed pool and do not need to add up to 100%. Maximum cycle rounds and consecutive rounds without improvement both default to 0. Both thresholds accept whole numbers from 0 to 100,000; 0 disables round-based early stopping. Automatic with both thresholds at 0 can continue until manual Stop and is not guaranteed to finish automatically. The total deadline and manual Stop always take priority. Valid input updates immediately and applies to the next run, never the active run. **Restore budget defaults** resets these eight controls only. Project files preserve them as `sheetCycleBudget`; new projects and missing legacy or partial fields receive the new defaults without changing the project version. Explicit stored stage values, including the old 200 / 350 ms slices, are preserved. Null, unknown fields and invalid values within `sheetCycleBudget` are rejected. Changing these budgets does not invalidate an existing layout because geometry is unchanged. Working layouts retain local improvements even when the outer rectangle does not shorten, while the best validated plan is kept separately. Evacuation first relocates a low-load source board's pieces into other occupied boards, then may remove and reinsert at most 4 blockers and 12 total pieces, with at most 3 source boards and 3 restarts per trial. Failed or canceled local trials retain the prior snapshot; all accepted layouts remain complete and collision-free. Board domains, holes, clearance and rotations are not relaxed. Empty boards disappear when results are split back to physical boards. The worker ranks virtual candidates by occupied board count before length, so emptying an earlier board is not discarded merely because the virtual right boundary increases; the outer scheduler still applies stock priorities and independent validation.

In **Settings → Time and stopping**, choose the total search time. The total `timeLimitSeconds` deadline and manual **Stop** take priority over every stage; there is no separate time limit per board combination. Automatic has no fixed total deadline. In sheet mode, Automatic with both round thresholds at 0 (the defaults) can continue until manual **Stop**; automatic completion is not guaranteed. In strip mode, Automatic still stops when improvement stalls. The obsolete `sheetCompressionSeconds` field is accepted in legacy files but ignored, even when its stored value is invalid; new projects and jobs do not create it or apply a fallback combination limit. The old `sheetInsertionWarmStartSeconds` and `sheetInsertionFailures` fields remain in saved projects for compatibility but no longer have UI controls or define a multiplied final-sheet compression budget.

Stock priority and a capacity pre-screen guide the initial board selection. A failed combination tries adding an available board. A successful combination tries removing boards or switching to smaller stock sizes. All boards in each candidate combination are solved in one Sparrow search rather than a sequence of per-board insertions. A worker tree and WASM `SheetSession` belong to the virtual-board combination, not to an individual physical board. Validated snapshots may seed a compatible candidate combination; rejected candidates cannot replace the best validated plan.

Live shows the current combination's selected board count, candidate combination round (`roundIndex`), and joint search or joint compression stage, alongside the validated candidate layout split into physical boards. The compatible progress phase values remain `Insertion` for joint search and `Compression` for joint compression; `insertionFailures` remains an interface compatibility field, not a per-board insertion counter in the UI. Solution, project storage and exports retain the best validated plan, not simply the latest candidate. Stop keeps the best validated plan found so far.

The combination search is heuristic: it does not guarantee the minimum board count, and a failed bounded search does not prove that a part or combination is impossible to place. Parts not included in a validated layout remain unplaced. Defects beyond imported stock holes, clamp zones and machine toolpaths are not included.

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
