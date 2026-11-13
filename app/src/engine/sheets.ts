import { jobStocks, stockArea } from './stock';
import type { SheetStage } from './sheetStage';
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
  onStage?: (stage: SheetStage) => void,
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
  selectedBoards?: number;
  stage?: SheetStage;
  compressionStatus?: 'running' | 'skipped-budget';
  sheetEndReason?:
    | 'failure-limit'
    | 'no-remaining-parts'
    | 'all-parts-placed'
    | 'initial-placement-failed'
    | 'stopped';
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
    let roundIndex = 0,
      failures = 0,
      lastImprovementAt = started;
    const progress = (
      phase: SheetProgress['phase'],
      selectedBoards: number,
      compressionStatus?: SheetProgress['compressionStatus'],
      stage?: SheetStage,
    ) =>
      options.onProgress?.({
        roundIndex,
        sheetIndex: 0,
        lastImprovementAt,
        phase,
        insertionFailures: failures,
        selectedBoards,
        ...(compressionStatus ? { compressionStatus } : {}),
        ...(stage ? { stage } : {}),
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
      let stepSequence = 0;
      let phase: SheetProgress['phase'] = 'Insertion';
      let stage: SheetStage | undefined;
      let compressionStatus: SheetProgress['compressionStatus'];
      const onStage = (step: number) => (next: SheetStage) => {
        if (!active || attemptController.signal.aborted || step !== stepSequence) return;
        stage = next;
        progress(phase, selected.length, compressionStatus, stage);
      };
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
          const step = ++stepSequence;
          const previousStage = stage;
          phase = 'Insertion';
          stage = undefined;
          compressionStatus = undefined;
          if (previousStage) progress(phase, selected.length);
          let initialFailed = false;
          try {
            const result = await untilAbort(
              solve(
                virtual.job,
                attemptController.signal,
                offer,
                Math.max(0, deadline - performance.now()),
                warm,
                undefined,
                onStage(step),
              ),
              attemptController.signal,
            );
            if (result) offer(result);
          } catch (error) {
            if (!isInitialPlacementFailure(error)) throw error;
            initialFailed = true;
          } finally {
            stepSequence++;
          }
          await flush();
          return initialFailed;
        };
        const initialFailed = await search(initial);
        if (initial && (initialFailed || !current) && !attemptController.signal.aborted)
          await search();
        if (current && raw && !attemptController.signal.aborted) {
          phase = 'Compression';
          stage = undefined;
          compressionStatus = undefined;
          progress(phase, selected.length);
          const remaining = Math.max(0, deadline - performance.now());
          if (remaining > 100) {
            const step = ++stepSequence;
            try {
              const result = await untilAbort(
                solve(
                  virtual.job,
                  attemptController.signal,
                  offer,
                  remaining,
                  raw,
                  (started) => {
                    if (!active || attemptController.signal.aborted || step !== stepSequence)
                      return;
                    compressionStatus = started ? 'running' : 'skipped-budget';
                    progress(phase, selected.length, compressionStatus, stage);
                  },
                  onStage(step),
                ),
                attemptController.signal,
              );
              if (result) offer(result);
            } finally {
              stepSequence++;
            }
            await flush();
          } else progress(phase, selected.length, 'skipped-budget');
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
    while (queue.length && !stopped()) {
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
