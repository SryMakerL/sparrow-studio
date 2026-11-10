# Native application solver ABI

The declarations in `include/sparrow_dotnet_native.h` are the binding contract. Existing `sparrow_solve_json`, cancellation-pointer, and string-free exports remain unchanged. This implementation is pure Rust; it does not invoke Node, browsers, or managed code.

## Ownership and concurrency

All `char *` results are independently allocated NUL-terminated UTF-8 and contain `{"ok":true,"result":...}` or `{"ok":false,"error":"..."}`. Release every result exactly once with `sparrow_string_free`. Every input pointer must be readable through NUL (maximum 10 MiB); no input buffer is retained.

Session IDs are monotonically increasing `uint64_t` registry keys, not addresses. Create returns `result.sessionId`. Start runs a native worker; step runs synchronously on the calling thread. Start/step on the same busy session return an error; poll, cancel, and free can execute concurrently. Free is idempotent, removes the registry key, requests cancellation, and does not wait. Already-admitted operations retain Arc ownership. Do not unload the DLL until running workers/steps have exited. Legacy pointer-token lifetime rules are unchanged: never free the token while synchronous solve/request accesses it.

## Application Job input

Uses the app camelCase Job/Part/Settings JSON. `sheetStocks` is now a typed nonempty inventory accepting rectangle and polygon stock, positive quantities, stable stock priorities 0..999, stock holes, and stock approximation tolerance. `sheetCount` accepts positive counts, not only one. `sheetInsertionWarmStartSeconds` accepts 1..600 (default 10); compression defaults to 10 seconds; insertion failure count defaults to 3. Part priorities and rotations remain supported. Duplicate closing/consecutive points are normalized; polygon stocks are translated to local zero-origin bounds. Existing finite/f32/topology checks remain in place.

A job with `sheetCount` or `sheetStocks` produces an aggregate. A job without either produces the compatible single strip/single finite sheet result. Finite stocks no longer require clearance to be smaller than width/length: narrow stocks use a native polygon candidate search. Continuous rotation in this fallback uses 5-degree samples, like the app. Part holes are conservatively solid for placement/overlap/clearance, matching the app validator; stock holes are forbidden material.

## Results and validation

Single results preserve `documentRevision`, `solverRevision`, string `seed`, `elapsedSeconds`, `usedLengthMm`, and rigid `placements`. `validation` is now independently computed (`passed` or `failed`), not `pending`. Validated kernel results additionally carry `snapshotId` and `cancelled`.

Aggregates have empty top-level `placements`, `sheets:[{job,result}]`, `unplaced:[{partId,quantity}]`, summed used length, and independently checked validation. Child jobs omit `sheetCount`/`sheetStocks`, carry the exact normalized `sheetStock` inventory snapshot, and have their selected quantities. `reason` is `Complete`, `Stopped`, `StockExhausted`, or `Unplaceable`; like app timed runs, a deadline ends with Complete even when copies remain unplaced. After all demand fits in a timed aggregate, the last board keeps compressing until the existing global deadline (or cancellation); this does not add time to the job budget. Automatic jobs without a deadline retain the compression-seconds times insertion-failure-limit final window. Validated final-board improvements continue to update current-round and best snapshots. Cancellation preserves the best validated result; a pre-cancelled aggregate returns a valid empty aggregate with all demand unplaced. A single solve cancelled before any candidate remains an error.

` sparrow_validate_json(job,result) ` independently checks demanded identities and quantities, duplicate copies, rigid-only transforms, allowed angles, f64 polygon intersections, boundary excess, stock holes, and clearance. Thresholds match app: linear 1e-6 mm, overlap 1e-8 mm2, angle 1e-4 degree. Aggregate checks include stock snapshots, inventory consumption, immutable part geometry, child settings, exact placed+unplaced conservation, and sum of used lengths.

## Session APIs

1. `sparrow_session_create_json(job, revision)` returns a session ID.
2. `sparrow_session_start_json(id, seed)` starts the entire native Job inventory solve.
3. `sparrow_session_poll_json(id)` returns `{sessionId,status,sequence,events,best,error}` and drains queued events. Status is idle/running/finished/cancelled/error. Queue is bounded to 256 events (oldest dropped); sequence is monotonic, and best is retained independently. Event types include phase, progress, candidate, current-round, finished. Candidate events carry `result`; step candidate events also carry `snapshotId`. Progress carries Insertion/Compression, roundIndex, sheetIndex, insertionFailures. There are no caller callbacks.
4. `sparrow_session_cancel(id)` requests cooperative cancellation; keep polling until not running.
5. `sparrow_session_free(id)` removes the ID and requests cancellation.

` sparrow_session_step_json(id, request, seed) ` is for single-sheet catalogs (no aggregate fields). Request: `{quantities:[usize...],mode:"search"|"compress"|"continuous",budget_ms?:0..600000,initial_snapshot?:u32,retain_snapshot?:u32,initial_placement?:{used_length_mm,placements:[{item_id,rotation,translation:[x,y]}]}}`. Quantity slots correspond to all input part types including zero-demand slots. `budgetMs` is also accepted as an alias. Search constructs/warms and returns immediately; compress uses absolute phase deadlines with geometric lower-bound early completion; continuous optimizes from the constructed solution. A new step retains only the requested initial/retained snapshots. Published snapshot IDs are never recycled. Unknown/expired IDs and quantity decreases below an existing snapshot are errors. Initial placement uses external degrees/mm.

## Search policy and limitations

Inventory ordering and priority scoring, validation gates, partial aggregates, repeated insertion passes with consecutive failure reset, two-failure stock skipping, and final compression windows are native. Single-sheet insertion still uses per-type exponential insertion and does not duplicate the app's exact bounded greedy batch-halving/cache/insertion-candidate rotation strategy. The polygon fallback now uses area/priority ordering, cyclic order rotation, seeded shuffles every third round, ceiling-stride contour samples, first-feasible continuous-angle selection, and an independent per-attempt deadline; its candidate anchors and fixed grid nevertheless remain a heuristic rather than geometric-complete nesting. As a result, successful placements, selected stock combination under difficult packing instances, and packing quality/runtime may differ from the app. Native solver construction and geometry Boolean operations cannot be interrupted in the middle of a long upstream operation; cancellation is cooperative between such operations. Session polling is bounded to 256 queued events and is not a lossless event log.
