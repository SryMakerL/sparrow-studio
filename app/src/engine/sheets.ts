import { optimizeParallelSheets } from './parallelSheets';
import { jobStocks, stockArea, stockGeometryKey } from './stock';
import { SOLVER_REVISION, POLICY, type Job, type Result, type Validation } from './model';
import { normalizeJob, area as ringArea } from './geometry/normalize';
import { validate } from './geometry/validate';

export const isInitialPlacementFailure = (error: unknown): boolean =>
  (error instanceof Error ? error.message : String(error)).startsWith(
    'No valid initial placement could be constructed for item ',
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
) => Promise<Result | undefined>) & {
  beginSheet?: (catalog: Job, signal?: AbortSignal) => void | Promise<void>;
  endSheet?: () => void;
  acceptCandidate?: (result: Result) => void;
  waitForIdle?: () => Promise<void>;
  forkSheet?: () => StripAttempt;
  continueSheet?: StripAttempt;
};

export type SheetProgress = {
  roundIndex: number;
  sheetIndex: number;
  lastImprovementAt: number;
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

function untilAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined);
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Each round has fresh seeds and caches; only validated improvements survive. */
export async function solveSheets(
  input: Job,
  solve: StripAttempt,
  options: SheetOptions = {},
): Promise<SheetOutcome> {
  const started = performance.now();
  const controller = new AbortController();
  const deadline =
    input.settings.timeLimitSeconds === null
      ? Infinity
      : started + input.settings.timeLimitSeconds * 1000;
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const timer = Number.isFinite(deadline)
    ? setTimeout(stop, Math.max(0, deadline - performance.now()))
    : undefined;
  const expired = () => {
    if (performance.now() >= deadline) stop();
    return controller.signal.aborted;
  };
  try {
    const job = options.normalize
      ? ((await untilAbort(options.normalize(input, controller.signal), controller.signal)) ??
        input)
      : normalizeJob(input);
    let best: Result = {
      documentRevision: options.revision ?? 0,
      solverRevision: SOLVER_REVISION,
      seed: '',
      elapsedSeconds: 0,
      usedLengthMm: 0,
      placements: [],
      sheets: [],
      unplaced: job.parts.map((p) => ({ partId: p.id, quantity: p.quantity })),
      validation: {
        status: 'passed',
        overlapAreaMm2: 0,
        maxBoundaryViolationMm: 0,
        minClearanceMm: null,
        errors: [],
      },
    };
    const priorities = new Map(job.parts.map((p) => [p.id, p.priority]));
    const priorityLevels = [...new Set(priorities.values())].sort((a, b) => b - a);
    const score = (result: Result) => [
      ...priorityLevels.map((priority) =>
        result.unplaced!.reduce(
          (sum, p) => sum + (priorities.get(p.partId) === priority ? p.quantity : 0),
          0,
        ),
      ),
      ...[...jobStocks(job)]
        .sort((a, b) => b.priority - a.priority)
        .map(
          (stock) =>
            -result
              .sheets!.filter((s) => s.job.settings.sheetStock?.id === stock.id)
              .reduce((n, s) => n + s.job.parts.reduce((m, p) => m + p.quantity, 0), 0),
        ),
      result.sheets!.length,
      ...Array.from(
        { length: job.settings.sheetCount ?? 0 },
        (_, i) => -(result.sheets![i]?.job.parts.reduce((sum, p) => sum + p.quantity, 0) ?? 0),
      ),
      result.usedLengthMm,
    ];
    const publish = (candidate: Result) => {
      if (expired()) return false;
      const a = score(candidate),
        b = score(best);
      const different = a.findIndex((value, i) => value !== b[i]);
      if (different < 0 || a[different] >= b[different]) return false;
      best = {
        ...structuredClone(candidate),
        elapsedSeconds: (performance.now() - started) / 1000,
      };
      options.onSheet?.(structuredClone(best));
      return true;
    };
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
          ) => {
            if (expired()) return undefined;
            return untilAbort(
              solve(child, signal, onCandidate, attemptBudgetMs, initialPlacement),
              signal,
            );
          },
          {
            beginSheet: solve.beginSheet,
            endSheet: solve.endSheet,
            acceptCandidate: solve.acceptCandidate,
            forkSheet: solve.forkSheet,
            continueSheet: solve.continueSheet,
          },
        ),
        {
          ...options,
          normalize: undefined,
          signal: controller.signal,
          deadline,
          roundIndex,
          pendingIds: best.unplaced!.map((p) => p.partId),
          validate: async (child, result, attemptSignal) => {
            if (expired() || attemptSignal?.aborted)
              return { ...best.validation, status: 'failed' };
            const checked = await untilAbort(
              Promise.resolve(
                options.validate
                  ? options.validate(child, result, attemptSignal)
                  : validate(child, result),
              ),
              attemptSignal,
            );
            if (expired() || attemptSignal?.aborted || !checked)
              return { ...best.validation, status: 'failed' };
            return checked;
          },
          onSheet: publish,
          onCurrentRound: (result, index) => {
            if (expired()) return;
            options.onCurrentRound?.(
              { ...structuredClone(result), elapsedSeconds: (performance.now() - started) / 1000 },
              index,
            );
          },
        },
      );
      publish(round.result);
      reason = round.reason;
      if (!round.result.unplaced?.length) break;
      roundIndex++;
      stagnant = previous === best ? stagnant + 1 : 0;
      if (!Number.isFinite(deadline) && stagnant >= 3) break;
      if (expired()) break;
      // Give timers and user cancellation a turn even with zero-cost strip solvers.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return {
      result: { ...best, elapsedSeconds: (performance.now() - started) / 1000 },
      reason: options.signal?.aborted ? 'Stopped' : Number.isFinite(deadline) ? 'Complete' : reason,
    };
  } finally {
    solve.endSheet?.();
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
  }
}

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
  const parallel = count > 1 && !!solve.forkSheet;
  const compressionMs = (job.settings.sheetCompressionSeconds ?? 10) * 1000;
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
  const attempt = async (
    ids: string[],
    mode: 'search' | 'compress' = 'search',
    initialPlacement?: Result,
  ): Promise<SheetEntry | undefined> => {
    if (stopped()) return;
    const remainingMs = (options.deadline ?? Infinity) - performance.now();
    const adding = !!initialPlacement && ids.length > initialPlacement.placements.length;
    const budget = Math.max(
      0,
      Math.min(mode === 'compress' ? compressionMs : adding ? 10_000 : 2500, remainingMs),
    );
    const quantities = new Map<string, number>();
    ids.forEach((id) => quantities.set(id, (quantities.get(id) ?? 0) + 1));
    const key =
      stockGeometryKey(stock) +
      JSON.stringify([...quantities].sort(([a], [b]) => a.localeCompare(b)));
    const cached = successful.get(key);
    if (cached && mode === 'search') return structuredClone(cached);
    if (budget < 50) return;
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
        if (verified && verified.result.usedLengthMm <= result.usedLengthMm) continue;
        verified = { job: child, result: { ...result, validation } };
        successful.set(key, structuredClone(verified));
        if (observe?.(verified)) {
          solve.acceptCandidate?.(verified.result);
          const snapshot = aggregate(verified);
          publishCurrent(snapshot);
          options.onSheet?.(snapshot);
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
    try {
      const result = await untilAbort(
        solve(child, solverController.signal, offer, budget, initialPlacement),
        solverController.signal,
      );
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
    let selected: string[] = [];
    const progress = () =>
      options.onProgress?.({
        roundIndex: options.roundIndex ?? 0,
        sheetIndex,
        lastImprovementAt,
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
        selected = ids;
        lastImprovementAt = performance.now();
        progress();
        return true;
      }
      return false;
    };
    const pool = ordered.flatMap((p) => Array.from({ length: remaining.get(p.id)! }, () => p.id));
    if (!pool.length) break;
    let insertionFailures = 0;
    let initialPass = true;
    while (!stopped()) {
      if (!initialPass && best) {
        successful.clear();
        await attempt([...selected], 'compress', best.result);
        if (stopped()) break;
        if (selected.length === pool.length) {
          if (sheets.length > 0 || parallel) break;
          await untilAbort(
            new Promise<void>((resolve) =>
              setTimeout(
                resolve,
                Math.min(100, Math.max(0, (options.deadline ?? Infinity) - performance.now())),
              ),
            ),
            signal,
          );
          continue;
        }
      }
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
        for (const id of new Set(available)) {
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
            const trial = (await attempt(ids, 'search', best?.result)) ?? (await attempt(ids));
            if (trial) {
              filledArea += (batch - low) * itemArea;
              low = batch;
              step *= 2;
            } else {
              high = batch - 1;
              step = Math.max(1, Math.floor(step / 2));
            }
          }
        }
      }
      if (initialPass) {
        initialPass = false;
      } else {
        insertionFailures = selected.length > beforeInsertion ? 0 : insertionFailures + 1;
        if (insertionFailures >= insertionFailureLimit) break;
      }
      if (!best || parallel) break;
      await untilAbort(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
    }
    solve.endSheet?.();
    observe = undefined;
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
  let result = aggregate();
  if (parallel && result.sheets!.length && !stopped()) {
    result = await optimizeParallelSheets(job, result, solve.forkSheet!, {
      signal,
      deadline: options.deadline ?? Infinity,
      validate: options.validate,
      onProgress: options.onProgress,
      onResult: (next) => {
        options.onSheet?.(structuredClone(next));
        options.onCurrentRound?.(structuredClone(next), options.roundIndex ?? 0);
      },
    });
  }
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
