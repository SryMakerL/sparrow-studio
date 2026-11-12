import { jobStocks, stockArea } from './stock';
import {
  SOLVER_REVISION,
  type Job,
  type Part,
  type Result,
  type SheetStock,
  type Validation,
} from './model';
import { normalizeJob, area } from './geometry/normalize';
import { validate } from './geometry/validate';
import {
  canUseStock,
  orderedStocks,
  selectBoards,
  splitVirtualResult,
  stitchBoards,
  type VirtualSheet,
} from './virtualSheets';

export const isInitialPlacementFailure = (error: unknown): boolean =>
  /^(No valid initial placement|Warm start insertion failed:|Invalid initial placement|Initial placement)/.test(
    error instanceof Error ? error.message : String(error),
  );

export type SheetEntry = { job: Job; result: Result };
export type SheetOutcome = {
  result: Result;
  reason: 'Complete' | 'Stopped' | 'StockExhausted' | 'Unplaceable';
};
export type StripAttempt = ((
  job: Job,
  signal?: AbortSignal,
  onCandidate?: (result: Result) => void,
  attemptBudgetMs?: number,
  initialPlacement?: Result,
  onStarted?: (started: boolean) => void,
) => Promise<Result | undefined>) & {
  beginSheet?: (catalog: Job, signal?: AbortSignal) => void | Promise<void>;
  endSheet?: () => void;
  acceptCandidate?: (result: Result) => void;
  continueSheet?: StripAttempt;
};
export type SheetProgress = {
  roundIndex: number;
  sheetIndex: number;
  lastImprovementAt: number;
  phase: 'Insertion' | 'Compression';
  insertionFailures: number;
<<<<<<< HEAD
  compressionStatus?: 'running' | 'skipped-budget';
  sheetEndReason?:
    | 'failure-limit'
    | 'no-remaining-parts'
    | 'all-parts-placed'
    | 'initial-placement-failed'
    | 'stopped';
=======
  selectedBoards?: number;
>>>>>>> dev
};
type SheetOptions = {
  onProgress?: (progress: SheetProgress) => void;
  signal?: AbortSignal;
  onSheet?: (result: Result) => void;
  onCurrentRound?: (result: Result, roundIndex: number) => void;
  revision?: number;
  normalize?: (job: Job, signal?: AbortSignal) => Promise<Job>;
  validate?: (job: Job, result: Result, signal?: AbortSignal) => Promise<Validation>;
};

function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** Each candidate is one joint solve over all selected, separated physical boards. */
export async function solveSheets(
  input: Job,
  solve: StripAttempt,
  options: SheetOptions = {},
): Promise<SheetOutcome> {
  const started = performance.now();
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const deadline =
    input.settings.timeLimitSeconds === null
      ? Infinity
      : started + input.settings.timeLimitSeconds * 1000;
  const timer = Number.isFinite(deadline)
    ? setTimeout(stop, Math.max(0, deadline - performance.now()))
    : undefined;
  const stopped = () => controller.signal.aborted || performance.now() >= deadline;
  try {
    const job = options.normalize
      ? ((await untilAbort(options.normalize(input, controller.signal), controller.signal)) ??
        input)
      : normalizeJob(input);
    const passed: Validation = {
      status: 'passed',
      overlapAreaMm2: 0,
      maxBoundaryViolationMm: 0,
      minClearanceMm: null,
      errors: [],
    };
    let best: Result = {
      documentRevision: options.revision ?? 0,
      solverRevision: SOLVER_REVISION,
      seed: '',
      elapsedSeconds: 0,
      usedLengthMm: 0,
      placements: [],
      sheets: [],
      unplaced: job.parts
        .filter((part) => part.quantity > 0)
        .map((part) => ({ partId: part.id, quantity: part.quantity })),
      validation: passed,
    };
    const stocks = orderedStocks(job);
    const priorities = [...new Set(job.parts.map((part) => part.priority))].sort((a, b) => b - a);
    const partPriorities = new Map(job.parts.map((part) => [part.id, part.priority]));
    const stockPriorities = [...new Set(jobStocks(job).map((stock) => stock.priority))].sort(
      (a, b) => b - a,
    );
    const score = (result: Result) => [
      ...priorities.map((priority) =>
        result.unplaced!.reduce(
          (sum, part) => sum + (partPriorities.get(part.partId) === priority ? part.quantity : 0),
          0,
        ),
      ),
      ...stockPriorities.map(
        (priority) =>
          -result
            .sheets!.filter((sheet) => sheet.job.settings.sheetStock?.priority === priority)
            .reduce((sum, sheet) => sum + sheet.result.placements.length, 0),
      ),
      result.sheets!.length,
      result.sheets!.reduce((sum, sheet) => sum + stockArea(sheet.job.settings.sheetStock!), 0),
      result.usedLengthMm,
    ];
    const better = (a: Result, b: Result) => {
      const left = score(a),
        right = score(b);
      const different = left.findIndex((value, index) => value !== right[index]);
      return different >= 0 && left[different] < right[different];
    };
<<<<<<< HEAD
    let stagnant = 0;
    let roundIndex = 0;
    let reason: SheetOutcome['reason'] = 'Unplaceable';
    while (!expired()) {
      if (deadline - performance.now() < 100 * Math.max(1, job.settings.sheetCount ?? 1)) {
        await untilAbort(new Promise<void>(() => {}), controller.signal);
        break;
      }
      const previous = best;
      const round = await solveSheetRound(
        job,
        Object.assign(
          async (
            child: Job,
            signal?: AbortSignal,
            onCandidate?: (result: Result) => void,
            attemptBudgetMs?: number,
            initialPlacement?: Result,
            onStarted?: (started: boolean) => void,
          ) => {
            if (expired()) return undefined;
            return untilAbort(
              solve(child, signal, onCandidate, attemptBudgetMs, initialPlacement, onStarted),
              signal,
            );
          },
          {
            beginSheet: solve.beginSheet,
            endSheet: solve.endSheet,
            acceptCandidate: solve.acceptCandidate,
            continueSheet: solve.continueSheet,
          },
=======
    let roundIndex = 0,
      failures = 0,
      lastImprovementAt = started;
    const progress = (phase: SheetProgress['phase'], selectedBoards: number) =>
      options.onProgress?.({
        roundIndex,
        sheetIndex: 0,
        lastImprovementAt,
        phase,
        insertionFailures: failures,
        selectedBoards,
      });
    const publish = (result: Result) => {
      result = { ...result, roundIndex, elapsedSeconds: (performance.now() - started) / 1000 };
      options.onCurrentRound?.(structuredClone(result), roundIndex);
      if (!better(result, best)) return;
      best = structuredClone(result);
      lastImprovementAt = performance.now();
      options.onSheet?.(structuredClone(best));
    };
    const checked = async (result: Result, signal: AbortSignal) => {
      const validation = await untilAbort(
        Promise.resolve(
          options.validate ? options.validate(job, result, signal) : validate(job, result),
>>>>>>> dev
        ),
        signal,
      );
      if (!validation || validation.status !== 'passed' || signal.aborted) return;
      result.validation = validation;
      for (const sheet of result.sheets!) sheet.result.validation = { ...passed };
      return result;
    };
    const warmStart = (virtual: VirtualSheet): Result | undefined => {
      if (!best.sheets?.length) return;
      const quantities = new Map(virtual.job.parts.map((part) => [part.id, part.quantity]));
      const counts = new Map<string, number>();
      const used = new Set<number>();
      const placements: Result['placements'] = [];
      for (const sheet of best.sheets) {
        const index = virtual.boards.findIndex(
          (board, i) => !used.has(i) && board.stock.id === sheet.job.settings.sheetStock?.id,
        );
        if (index < 0) continue;
        used.add(index);
        for (const placement of sheet.result.placements) {
          const count = counts.get(placement.partId) ?? 0;
          if (count >= (quantities.get(placement.partId) ?? 0)) continue;
          placements.push({
            ...placement,
            xMm: placement.xMm + virtual.boards[index].xMm,
            copyIndex: count,
          });
          counts.set(placement.partId, count + 1);
        }
      }
      return placements.length
        ? {
            ...best,
            sheets: undefined,
            unplaced: undefined,
            placements,
            usedLengthMm: virtual.job.settings.sheetLengthMm!,
            validation: passed,
          }
        : undefined;
    };
    const attempt = async (selected: SheetStock[], parts: Part[]): Promise<Result | undefined> => {
      if (stopped() || !selected.length || !parts.some((part) => part.quantity > 0)) return;
      const virtual = stitchBoards(job, selected, parts);
      const attemptStarted = performance.now();
      const budget = deadline - performance.now();
      if (budget < 50) return;
      const attemptController = new AbortController();
      const abort = () => attemptController.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      const attemptTimer = Number.isFinite(budget) ? setTimeout(abort, budget) : undefined;
      let active = true,
        current: Result | undefined,
        raw: Result | undefined;
      let latest: Result | undefined, checking: Promise<void> | undefined, validationError: unknown;
      const drain = async () => {
        while (latest && active && !attemptController.signal.aborted) {
          const candidate = latest;
          latest = undefined;
          const aggregate = splitVirtualResult(job, virtual, candidate, options.revision);
          if (!aggregate) continue;
          const valid = await checked(aggregate, attemptController.signal);
          if (!valid || !active || attemptController.signal.aborted) continue;
          if (!current || better(valid, current)) {
            current = valid;
            raw = candidate;
          }
          solve.acceptCandidate?.(candidate);
          publish(valid);
        }
      };
      const offer = (candidate: Result) => {
        if (!active || attemptController.signal.aborted) return;
        latest = structuredClone(candidate);
        if (checking) return;
        checking = (async () => {
          while (latest && active && !attemptController.signal.aborted) await drain();
        })()
          .catch((error) => {
            validationError = error;
          })
          .finally(() => {
            checking = undefined;
          });
      };
      const flush = async () => {
        while (checking && !attemptController.signal.aborted)
          await untilAbort(checking, attemptController.signal);
        if (validationError) throw validationError;
      };
      try {
        progress('Insertion', selected.length);
        await untilAbort(
          Promise.resolve(solve.beginSheet?.(virtual.job, attemptController.signal)),
          attemptController.signal,
        );
        if (attemptController.signal.aborted) return;
        const initial = warmStart(virtual);
        const search = async (warm?: Result) => {
          const result = await untilAbort(
            solve(
              virtual.job,
              attemptController.signal,
              offer,
              Math.max(0, budget - (performance.now() - attemptStarted)),
              warm,
            ),
            attemptController.signal,
          );
          if (result) offer(result);
          await flush();
        };
        await search(initial);
        if (!current && initial && !attemptController.signal.aborted) await search();
        if (current && raw && !attemptController.signal.aborted) {
          progress('Compression', selected.length);
          const remaining = Math.max(0, budget - (performance.now() - attemptStarted));
          if (remaining > 100) {
            const result = await untilAbort(
              solve(virtual.job, attemptController.signal, offer, remaining, raw),
              attemptController.signal,
            );
            if (result) offer(result);
            await flush();
          }
        }
        return current;
      } catch (error) {
        if (attemptController.signal.aborted || isInitialPlacementFailure(error)) return current;
        throw error;
      } finally {
        active = false;
        latest = undefined;
        clearTimeout(attemptTimer);
        controller.signal.removeEventListener('abort', abort);
        attemptController.abort();
        solve.endSheet?.();
      }
    };
    let parts = job.parts
      .filter((part) => part.quantity > 0 && stocks.some((stock) => canUseStock(part, stock)))
      .sort((a, b) => b.priority - a.priority || Math.abs(area(b.outer)) - Math.abs(area(a.outer)));
    let selected = selectBoards(job, parts);
    const signature = (boards: SheetStock[], demand: Part[]) =>
      JSON.stringify([
        boards.map((stock) => stock.id).sort(),
        demand
          .map((part) => [part.id, part.quantity])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ]);
    const tried = new Set<string>();
    const queue: { boards: SheetStock[]; parts: Part[] }[] = [];
    const enqueue = (boards: SheetStock[], demand = parts) => {
      if (
        boards.length &&
        boards.length <= 1000 &&
        boards.reduce((sum, stock) => sum + stock.lengthMm, 0) +
          Math.max(0, boards.length - 1) * Math.max(1, job.settings.clearanceMm) <=
          10_000_000 &&
        demand.some((part) => part.quantity > 0) &&
        !tried.has(signature(boards, demand))
      )
        queue.push({ boards, parts: demand });
    };
    enqueue(selected);
    const limit = Math.min(32, Math.max(8, stocks.length * 2 + 4));
    while (queue.length && !stopped() && roundIndex < limit) {
      const next = queue.shift()!;
      selected = next.boards;
      parts = next.parts;
      const key = signature(selected, parts);
      if (tried.has(key)) continue;
      tried.add(key);
      const result = await attempt(selected, parts);
      roundIndex++;
      if (stopped()) break;
      if (result) {
        failures = 0;
        const used = result.sheets!.map((sheet) => sheet.job.settings.sheetStock!);
        const requiredArea = parts.reduce(
          (sum, part) => sum + Math.abs(area(part.outer)) * part.quantity,
          0,
        );
        const removable = used
          .map((stock, index) => ({
            stock,
            index,
            count: result.sheets![index].result.placements.length,
          }))
          .sort((a, b) => a.stock.priority - b.stock.priority || a.count - b.count);
        for (const { index } of removable.slice(0, 3)) {
          const reduced = used.filter((_, i) => i !== index);
          if (
            reduced.reduce((sum, stock) => sum + stockArea(stock), 0) >= requiredArea &&
            parts.every((part) => reduced.some((stock) => canUseStock(part, stock)))
          )
            enqueue(reduced);
        }
        // Swap a board for a smaller in-stock alternative without enumerating all combinations.
        for (const stock of stocks) {
          if (used.filter((board) => board.id === stock.id).length >= stock.quantity) continue;
          const index = used.findIndex(
            (board) => board.priority <= stock.priority && stockArea(board) > stockArea(stock),
          );
          if (index < 0) continue;
          const swapped = used.map((board, i) => (i === index ? stock : board));
          if (
            swapped.reduce((sum, board) => sum + stockArea(board), 0) >= requiredArea &&
            parts.every((part) => swapped.some((board) => canUseStock(part, board)))
          )
            enqueue(swapped);
          break;
        }
        if (
          result.unplaced!.length &&
          parts.reduce((sum, part) => sum + part.quantity, 0) <
            job.parts.reduce((sum, part) => sum + part.quantity, 0)
        ) {
          const full = job.parts
            .filter((part) => part.quantity > 0 && stocks.some((stock) => canUseStock(part, stock)))
            .sort((a, b) => b.priority - a.priority);
          const quantities = new Map(parts.map((part) => [part.id, part.quantity]));
          let recovered = false;
          const expanded = full
            .map((part) => {
              const quantity = quantities.get(part.id) ?? 0;
              if (recovered || quantity === part.quantity) return { ...part, quantity };
              recovered = true;
              return {
                ...part,
                quantity: quantity + Math.max(1, Math.ceil((part.quantity - quantity) / 2)),
              };
            })
            .filter((part) => part.quantity > 0);
          enqueue(selected, expanded);
          enqueue(selectBoards(job, full, 0.65), full);
        }
      } else if (best.unplaced!.length) {
        failures++;
        const extra =
          selected.length < 1000
            ? stocks.find(
                (stock) =>
                  selected.filter((board) => board.id === stock.id).length < stock.quantity,
              )
            : undefined;
        if (extra) {
          const count = Math.min(
            extra.quantity - selected.filter((board) => board.id === extra.id).length,
            Math.max(1, Math.ceil(selected.length * 0.25)),
            1000 - selected.length,
          );
          enqueue([...selected, ...Array<SheetStock>(count).fill(extra)]);
        } else {
          let remove = Math.max(
            1,
            Math.ceil(parts.reduce((sum, part) => sum + part.quantity, 0) * 0.2),
          );
          const reduced = [...parts]
            .sort(
              (a, b) =>
                a.priority - b.priority || Math.abs(area(b.outer)) - Math.abs(area(a.outer)),
            )
            .map((part) => {
              const retained = best.sheets!.reduce(
                (sum, sheet) =>
                  sum + (sheet.job.parts.find((placed) => placed.id === part.id)?.quantity ?? 0),
                0,
              );
              const count = Math.min(remove, Math.max(0, part.quantity - retained));
              remove -= count;
              return { ...part, quantity: part.quantity - count };
            })
            .filter((part) => part.quantity > 0)
            .sort((a, b) => b.priority - a.priority);
          enqueue(selected, reduced);
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    best.elapsedSeconds = (performance.now() - started) / 1000;
    return {
      result: best,
      reason: options.signal?.aborted
        ? 'Stopped'
        : !best.unplaced!.length
          ? 'Complete'
          : best.sheets!.length
            ? 'StockExhausted'
            : 'Unplaceable',
    };
  } finally {
    solve.endSheet?.();
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
  }
}
<<<<<<< HEAD

/** Bounded greedy bin packing. Every rejected combination is solved again, never clipped. */
async function solveSheetRound(
  input: Job,
  solve: StripAttempt,
  options: SheetOptions & {
    deadline?: number;
    roundIndex?: number;
    pendingIds?: string[];
  } = {},
): Promise<SheetOutcome> {
  const signal = options.signal;
  const stopped = () => {
    if (options.deadline !== undefined && performance.now() >= options.deadline) return true;
    return signal?.aborted ?? false;
  };
  const job = input;
  const stocks = jobStocks(job)
    .map((stock, index) => ({ stock, index }))
    .sort((a, b) => b.stock.priority - a.stock.priority || a.index - b.index)
    .flatMap(({ stock }) => Array.from({ length: stock.quantity }, () => stock));
  let stock = stocks[0];
  let length = stock.lengthMm;
  const count = stocks.length;
  const compressionMs = (job.settings.sheetCompressionSeconds ?? 10) * 1000;
  const insertionWarmStartMs = (job.settings.sheetInsertionWarmStartSeconds ?? 10) * 1000;
  const insertionFailureLimit = job.settings.sheetInsertionFailures ?? 3;
  const started = performance.now(),
    sheets: SheetEntry[] = [];
  const remaining = new Map(job.parts.map((p) => [p.id, p.quantity]));
  const rejected = new Set<string>();
  const successful = new Map<string, SheetEntry>();
  const areas = new Map(job.parts.map((p) => [p.id, Math.abs(ringArea(p.outer))]));
  let capacity = stockArea(stock);
  let replacingIndex: number | undefined;
  const aggregate = (current?: SheetEntry): Result => {
    const entries = [...sheets];
    if (current) {
      if (replacingIndex === undefined) entries.push(current);
      else entries[replacingIndex] = current;
    }
    const pending = new Map(remaining);
    if (replacingIndex === undefined)
      current?.job.parts.forEach((p) => pending.set(p.id, pending.get(p.id)! - p.quantity));
    return {
      documentRevision: options.revision ?? 0,
      solverRevision: SOLVER_REVISION,
      roundIndex: options.roundIndex ?? 0,
      seed: entries[0]?.result.seed ?? '',
      elapsedSeconds: (performance.now() - started) / 1000,
      usedLengthMm: entries.reduce((sum, s) => sum + s.result.usedLengthMm, 0),
      placements: [],
      sheets: entries,
      unplaced: job.parts
        .filter((p) => pending.get(p.id)! > 0)
        .map((p) => ({ partId: p.id, quantity: pending.get(p.id)! })),
      validation: {
        status: 'passed',
        overlapAreaMm2: 0,
        maxBoundaryViolationMm: 0,
        minClearanceMm: null,
        errors: [],
      },
    };
  };
  let currentSheetIndex = 0;
  const publishCurrent = (result = aggregate()) => {
    if (!stopped())
      options.onCurrentRound?.({ ...result, currentSheetIndex }, options.roundIndex ?? 0);
  };
  publishCurrent();
  let observe: ((entry: SheetEntry) => boolean) | undefined;
  let observeWorking: ((entry: SheetEntry) => boolean) | undefined;
  const attempt = async (
    ids: string[],
    mode: 'search' | 'compress' = 'search',
    initialPlacement?: Result,
<<<<<<< HEAD
    onStarted?: (started: boolean) => void,
=======
    insertion = false,
    compressionBudgetMs = compressionMs,
>>>>>>> dev
  ): Promise<SheetEntry | undefined> => {
    if (stopped()) return;
    const remainingMs = (options.deadline ?? Infinity) - performance.now();
    const adding = !!initialPlacement && ids.length > initialPlacement.placements.length;
    const budget = Math.max(
      0,
      Math.min(
        mode === 'compress'
          ? compressionBudgetMs
          : insertion || adding
            ? insertionWarmStartMs
            : 2500,
        remainingMs,
      ),
    );
    const quantities = new Map<string, number>();
    ids.forEach((id) => quantities.set(id, (quantities.get(id) ?? 0) + 1));
    const key =
      stockGeometryKey(stock) +
      JSON.stringify([...quantities].sort(([a], [b]) => a.localeCompare(b)));
    const cached = successful.get(key);
    if (cached && mode === 'search') return structuredClone(cached);
    if (budget < 50) {
      if (remainingMs < 50 && Number.isFinite(remainingMs))
        await untilAbort(
          new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, remainingMs))),
          signal,
        );
      return;
    }
    const solverController = new AbortController();
    const attemptController = new AbortController();
    const stopSolver = () => solverController.abort();
    const stopAttempt = () => {
      attemptController.abort();
      stopSolver();
    };
    signal?.addEventListener('abort', stopAttempt, { once: true });
    const attemptDeadline = performance.now() + budget;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkDeadline = () => {
      const wait = attemptDeadline - performance.now();
      if (wait <= 0) stopAttempt();
      else if (Number.isFinite(wait)) timer = setTimeout(checkDeadline, wait);
    };
    checkDeadline();
    const attemptStopped = () => stopped() || attemptController.signal.aborted;
    const { sheetCount: _, sheetStocks: _stocks, ...settings } = job.settings;
    const child: Job = {
      ...job,
      settings: {
        ...settings,
        sheetStock: structuredClone(stock),
        sheetLengthMm: stock.lengthMm,
        materialWidthMm: stock.widthMm,
        timeLimitSeconds: 10,
      },
      parts: job.parts
        .filter((p) => quantities.has(p.id))
        .map((p) => ({ ...p, quantity: quantities.get(p.id)! })),
    };
    let verified: SheetEntry | undefined;
    let latest: Result | undefined;
    let submitted: Result | undefined;
    let checking: Promise<void> | undefined;
    let failure: unknown;
    let active = true;
    const drain = async () => {
      while (latest && active && !attemptStopped()) {
        const result = latest;
        latest = undefined;
        const validation = options.validate
          ? await options.validate(child, result, attemptController.signal)
          : validate(child, result);
        if (!active || attemptStopped()) return;
        if (validation.status !== 'passed') continue;
        if (
          verified &&
          (verified.result.usedLengthMm < result.usedLengthMm ||
            (mode === 'search' && verified.result.usedLengthMm === result.usedLengthMm))
        )
          continue;
        verified = { job: child, result: { ...result, validation } };
        successful.set(key, structuredClone(verified));
        if (observe?.(verified)) {
          solve.acceptCandidate?.(verified.result);
          const snapshot = aggregate(verified);
          publishCurrent(snapshot);
          options.onSheet?.(snapshot);
        } else if (mode === 'compress' && observeWorking?.(verified)) {
          solve.acceptCandidate?.(verified.result);
        }
        if (mode === 'search') stopSolver();
      }
    };
    const pump = () => {
      if (checking) return;
      checking = drain()
        .catch((error) => {
          failure = error;
        })
        .finally(() => {
          checking = undefined;
          if (latest && active && !attemptStopped()) pump();
        });
    };
    const offer = (result: Result) => {
      if (
        !active ||
        attemptStopped() ||
        result === submitted ||
        result.sheets ||
        result.unplaced ||
        result.usedLengthMm > length + POLICY.linearMm
      )
        return;
      submitted = result;
      latest = structuredClone(result);
      pump();
    };
    let startReported = false;
    try {
      const result = await untilAbort(
        solve(child, solverController.signal, offer, budget, initialPlacement, (started) => {
          startReported = true;
          if (mode === 'compress') onStarted?.(started);
        }),
        solverController.signal,
      );
      if (mode === 'compress' && !startReported) onStarted?.(false);
      if (result) offer(result);
      while (checking && !attemptStopped()) await untilAbort(checking, attemptController.signal);
      if (failure) throw failure;
      return verified;
    } catch (error) {
      if (isInitialPlacementFailure(error)) return verified;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stopAttempt);
      active = false;
      stopAttempt();
      latest = undefined;
    }
  };
  const ordered = [...job.parts].sort((a, b) => areas.get(b.id)! - areas.get(a.id)!);
  const offset = (options.roundIndex ?? 0) % ordered.length;
  ordered.push(...ordered.splice(0, offset));
  if ((options.roundIndex ?? 0) > 0 && options.pendingIds?.length) {
    const pending = new Set(options.pendingIds);
    ordered.sort((a, b) => Number(pending.has(b.id)) - Number(pending.has(a.id)));
  }
  ordered.sort((a, b) => b.priority - a.priority);
  const priorityLevels = [...new Set(job.parts.map((p) => p.priority))].sort((a, b) => b - a);
  const failedStocks = new Map<string, number>();
  for (let sheetIndex = 0; sheetIndex < count && !stopped(); sheetIndex++) {
    stock = stocks[sheetIndex];
    if ((failedStocks.get(stock.id) ?? 0) >= 2) continue;
    length = stock.lengthMm;
    capacity = stockArea(stock);
    currentSheetIndex = sheetIndex;
    solve.endSheet?.();
    await solve.beginSheet?.(
      {
        ...job,
        settings: {
          ...job.settings,
          sheetStock: structuredClone(stock),
          sheetLengthMm: stock.lengthMm,
          materialWidthMm: stock.widthMm,
        },
      },
      signal,
    );
    if (stopped()) break;
    if (sheetIndex > 0) publishCurrent();
    let lastImprovementAt = performance.now();
    let best: SheetEntry | undefined;
    let working: SheetEntry | undefined;
    let selected: string[] = [];
    let insertionFailures = 0;
    let sheetEndReason: SheetProgress['sheetEndReason'];
    let compressionStatus: SheetProgress['compressionStatus'];
    let insertionPass = 0;
    let previousFailed = new Set<string>();
    let phase: SheetProgress['phase'] = 'Insertion';
    const progress = () =>
      options.onProgress?.({
        roundIndex: options.roundIndex ?? 0,
        sheetIndex,
        lastImprovementAt,
        phase,
        insertionFailures,
        compressionStatus,
        sheetEndReason,
      });
    progress();
    observe = (entry) => {
      const ids = entry.job.parts.flatMap((p) => Array<string>(p.quantity).fill(p.id));
      const priorityCounts = (parts: Job['parts']) =>
        priorityLevels.map((priority) =>
          parts.reduce((sum, p) => sum + (p.priority === priority ? p.quantity : 0), 0),
        );
      const counts = priorityCounts(entry.job.parts);
      const bestCounts = best ? priorityCounts(best.job.parts) : counts.map(() => 0);
      const different = counts.findIndex((value, i) => value !== bestCounts[i]);
      if (
        !best ||
        (different >= 0 && counts[different] > bestCounts[different]) ||
        (different < 0 && entry.result.usedLengthMm < best.result.usedLengthMm)
      ) {
        best = entry;
        working = entry;
        selected = ids;
        lastImprovementAt = performance.now();
        progress();
        return true;
      }
      return false;
    };
    observeWorking = (entry) => {
      if (
        !working ||
        entry.result.usedLengthMm > working.result.usedLengthMm ||
        JSON.stringify(entry.result.placements) === JSON.stringify(working.result.placements)
      )
        return false;
      working = entry;
      return true;
    };
    const pool = ordered.flatMap((p) => Array.from({ length: remaining.get(p.id)! }, () => p.id));
    if (!pool.length) {
      sheetEndReason = 'no-remaining-parts';
      progress();
      break;
    }
    let initialPass = true;
    let finalCompressionDeadline: number | undefined;
    while (!stopped()) {
      if (!initialPass && best) {
        if (selected.length === pool.length)
          finalCompressionDeadline ??= Math.min(
            performance.now() + compressionMs * insertionFailureLimit,
            options.deadline ?? Infinity,
          );
        const remainingCompressionMs =
          finalCompressionDeadline === undefined
            ? compressionMs
            : finalCompressionDeadline - performance.now();
        if (remainingCompressionMs <= 0) break;
        phase = 'Compression';
        compressionStatus = undefined;
        progress();
        successful.clear();
<<<<<<< HEAD
        await attempt([...selected], 'compress', working!.result, (started) => {
          compressionStatus = started ? 'running' : 'skipped-budget';
          progress();
        });
        await attempt([...selected], 'compress', working!.result);
        if (stopped()) break;
        compressionStatus = undefined;
        if (selected.length === pool.length) {
          if (sheets.length > 0) {
            sheetEndReason = 'all-parts-placed';
            break;
          }
=======
        await attempt(
          [...selected],
          'compress',
          working!.result,
          false,
          Math.min(compressionMs, remainingCompressionMs),
        );
        if (stopped()) break;
        if (finalCompressionDeadline !== undefined) {
          if (performance.now() >= finalCompressionDeadline) break;
>>>>>>> dev
          await untilAbort(
            new Promise<void>((resolve) =>
              setTimeout(
                resolve,
                Math.min(100, Math.max(0, finalCompressionDeadline! - performance.now())),
              ),
            ),
            signal,
          );
          continue;
        }
      }
      phase = 'Insertion';
      progress();
      const beforeInsertion = selected.length;
      successful.clear();
      rejected.clear();
      if (!best) {
        let area = 0;
        let trialIds = pool.filter((id) => {
          const next = areas.get(id)!;
          if (area + next > capacity + POLICY.overlapMm2) return false;
          area += next;
          return true;
        });
        if (!trialIds.length) trialIds = [pool[0]];
        let initial: SheetEntry | undefined;
        while (trialIds.length && !stopped()) {
          initial = await attempt(trialIds);
          if (initial) break;
          if (trialIds.length === 1) {
            rejected.add(trialIds[0]);
            trialIds = pool.filter((id) => !rejected.has(id)).slice(0, 1);
          } else trialIds = trialIds.slice(0, Math.max(1, Math.floor(trialIds.length / 2)));
        }
      }
      if (best) {
        const available = [...pool];
        selected.forEach((id) => available.splice(available.indexOf(id), 1));
        let filledArea = selected.reduce((sum, id) => sum + areas.get(id)!, 0);
        const availableIds = [...new Set(available)];
        const candidates = priorityLevels.flatMap((priority) => {
          const group = availableIds.filter(
            (id) => job.parts.find((part) => part.id === id)!.priority === priority,
          );
          if (!group.length) return group;
          const offset = insertionPass % group.length;
          const rotated = [...group.slice(offset), ...group.slice(0, offset)];
          return rotated.sort(
            (a, b) => Number(previousFailed.has(a)) - Number(previousFailed.has(b)),
          );
        });
        const failed = new Set<string>();
        for (const id of candidates) {
          const itemArea = areas.get(id)!;
          let low = 0;
          let high = Math.min(
            available.filter((item) => item === id).length,
            Math.floor((capacity - filledArea + POLICY.overlapMm2) / itemArea),
          );
          let step = 1;
          while (low < high && !stopped()) {
            const batch = Math.min(high, low + step);
            const before = [...selected];
            const ids = [...before, ...Array<string>(batch - low).fill(id)];
            const trial = await attempt(ids, 'search', working?.result, true);
            if (trial) {
              filledArea += (batch - low) * itemArea;
              low = batch;
              step *= 2;
            } else {
              if (!stopped()) failed.add(id);
              high = batch - 1;
              step = Math.max(1, Math.floor(step / 2));
            }
          }
        }
        previousFailed = failed;
        insertionPass++;
      }
      if (stopped()) break;
      if (initialPass) {
        initialPass = false;
      } else {
        insertionFailures = selected.length > beforeInsertion ? 0 : insertionFailures + 1;
        progress();
        if (insertionFailures > insertionFailureLimit) {
          sheetEndReason = 'failure-limit';
          break;
        }
      }
      if (!best) {
        sheetEndReason = stopped() ? 'stopped' : 'initial-placement-failed';
        break;
      }
      await untilAbort(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
    }
    if (stopped()) sheetEndReason = 'stopped';
    else if ([...remaining.values()].every((quantity) => quantity <= 0))
      sheetEndReason = 'all-parts-placed';
    if (sheetEndReason) progress();
    solve.endSheet?.();
    observe = undefined;
    observeWorking = undefined;
    if (!best) failedStocks.set(stock.id, (failedStocks.get(stock.id) ?? 0) + 1);
    else failedStocks.delete(stock.id);
    if (best) {
      sheets.push(best);
      selected.forEach((id) => remaining.set(id, remaining.get(id)! - 1));
      const snapshot = aggregate();
      options.onSheet?.(snapshot);
      publishCurrent(snapshot);
    }
  }
  const result = aggregate();
  return {
    result,
    reason: options.signal?.aborted
      ? 'Stopped'
      : !result.unplaced!.length
        ? 'Complete'
        : sheets.length >= count
          ? 'StockExhausted'
          : 'Unplaceable',
  };
}
=======
>>>>>>> dev
