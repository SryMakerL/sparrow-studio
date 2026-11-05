import { cpuBudget } from './cpuBudget';
import type { Job, Result, Validation } from './model';
import { validate as validateGeometry } from './geometry/validate';
import {
  isInitialPlacementFailure,
  type SheetEntry,
  type SheetProgress,
  type StripAttempt,
} from './sheets';

type Options = {
  signal?: AbortSignal;
  deadline: number;
  validate?: (job: Job, result: Result, signal?: AbortSignal) => Promise<Validation>;
  onResult?: (result: Result) => void;
  onProgress?: (progress: SheetProgress) => void;
};
type Board = SheetEntry & {
  solve: StripAttempt;
  opened: boolean;
  busy: boolean;
  locked: boolean;
  pauseRequested: boolean;
  local?: AbortController;
  task?: Promise<void>;
  lastUsed: number;
  version: number;
  failures: number;
  lastImprovementAt: number;
  compressionElapsed: number;
  initialized: boolean;
};

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      resolve(undefined);
    };
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

/** Board mutations are committed only after validating a quantity-conserving aggregate. */
export async function optimizeParallelSheets(
  job: Job,
  initial: Result,
  create: () => StripAttempt,
  options: Options,
): Promise<Result> {
  let best = structuredClone(initial);
  const started = performance.now();
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const timer = Number.isFinite(options.deadline)
    ? setTimeout(stop, Math.max(0, options.deadline - performance.now()))
    : undefined;
  const stopped = () => {
    if (performance.now() >= options.deadline) stop();
    return controller.signal.aborted;
  };
  const boards: Board[] = [];
  const limit = job.settings.sheetInsertionFailures ?? 3;
  const concurrency = Math.min(
    job.settings.sheetConcurrency ?? 3,
    cpuBudget(job.settings.solverThreads).concurrencyCap,
  );
  const compressionMs = (job.settings.sheetCompressionSeconds ?? 10) * 1000;
  const residentLimit = Math.max(concurrency, Math.min(initial.sheets?.length ?? 0, 8));
  const wakeups = new Set<() => void>();
  const wake = () => {
    for (const resolve of [...wakeups]) resolve();
  };
  controller.signal.addEventListener('abort', wake);
  const changed = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        wakeups.delete(done);
        resolve();
      };
      wakeups.add(done);
      if (controller.signal.aborted) done();
    });
  let computing = 0;
  const permits: { priority: boolean; resolve: (value: boolean) => void }[] = [];
  const acquire = (priority: boolean): Promise<boolean> => {
    if (stopped()) return Promise.resolve(false);
    if (computing < concurrency && !permits.length) {
      computing++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = { priority, resolve };
      if (priority) {
        const index = permits.findIndex((entry) => !entry.priority);
        permits.splice(index < 0 ? permits.length : index, 0, waiter);
      } else permits.push(waiter);
    });
  };
  const releasePermit = () => {
    computing--;
    const next = permits.shift();
    if (next) {
      if (!stopped()) {
        computing++;
        next.resolve(true);
      } else next.resolve(false);
    }
    wake();
  };
  controller.signal.addEventListener('abort', () => {
    for (const waiter of permits.splice(0)) waiter.resolve(false);
  });
  let roundIndex = initial.roundIndex ?? 0;
  let commits: Promise<unknown> = Promise.resolve();
  const close = (board: Board) => {
    if (!board.opened) return;
    board.opened = false;
    board.solve.endSheet?.();
  };
  const progress = (board: Board) => {
    if (!stopped())
      options.onProgress?.({
        roundIndex,
        sheetIndex: boards.indexOf(board),
        lastImprovementAt: board.lastImprovementAt,
      });
  };
  const aggregate = (changes = new Map<Board, SheetEntry>()): Result => {
    const sheets = boards
      .map((board) => changes.get(board) ?? board)
      .filter((entry) => entry.job.parts.some((part) => part.quantity > 0))
      .map((entry) => ({ job: entry.job, result: entry.result }));
    const placed = new Map<string, number>();
    for (const sheet of sheets)
      for (const part of sheet.job.parts)
        placed.set(part.id, (placed.get(part.id) ?? 0) + part.quantity);
    return {
      ...best,
      elapsedSeconds: initial.elapsedSeconds + (performance.now() - started) / 1000,
      placements: [],
      sheets,
      usedLengthMm: sheets.reduce((sum, sheet) => sum + sheet.result.usedLengthMm, 0),
      unplaced: job.parts
        .filter((part) => part.quantity > (placed.get(part.id) ?? 0))
        .map((part) => ({ partId: part.id, quantity: part.quantity - (placed.get(part.id) ?? 0) })),
    };
  };
  const check = async (child: Job, result: Result, signal: AbortSignal) =>
    raceAbort(
      Promise.resolve().then(() =>
        options.validate
          ? options.validate(child, structuredClone(result), signal)
          : validateGeometry(child, result),
      ),
      signal,
    );
  const commit = (
    changes: Map<Board, SheetEntry>,
    versions: Map<Board, number>,
    signal: AbortSignal,
  ) => {
    const work = commits.then(async () => {
      const current = () =>
        !stopped() &&
        !signal.aborted &&
        [...versions].every(
          ([board, version]) => boards.includes(board) && board.version === version,
        );
      if (!current()) return false;
      const snapshot = aggregate(changes);
      const checked = await check(job, snapshot, signal);
      if (!current() || checked?.status !== 'passed') return false;
      for (const [board, entry] of changes) {
        board.job = entry.job;
        board.result = entry.result;
        board.version++;
        board.lastImprovementAt = performance.now();
      }
      for (let index = boards.length - 1; index >= 0; index--) {
        if (!boards[index].job.parts.length) {
          close(boards[index]);
          boards.splice(index, 1);
        }
      }
      best = structuredClone({ ...snapshot, validation: checked });
      for (const board of changes.keys()) if (boards.includes(board)) progress(board);
      options.onResult?.(structuredClone(best));
      return true;
    });
    commits = work.catch(() => {});
    return raceAbort(work, signal);
  };
  let useSequence = 0;
  const open = async (board: Board, signal: AbortSignal) => {
    if (stopped() || signal.aborted) return;
    board.busy = true;
    board.lastUsed = ++useSequence;
    if (board.opened) return;
    while (!board.opened && !stopped() && !signal.aborted) {
      if (boards.filter((entry) => entry.opened).length < residentLimit) break;
      const idle = boards
        .filter((entry) => entry.opened && !entry.busy && !entry.locked)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle) {
        close(idle);
        break;
      }
      await raceAbort(changed(), signal);
    }
    if (stopped() || signal.aborted) return;
    board.opened = true;
    try {
      await raceAbort(
        Promise.resolve().then(() =>
          board.solve.beginSheet?.(
            {
              ...structuredClone(job),
              settings: structuredClone(board.job.settings),
            },
            signal,
          ),
        ),
        signal,
      );
      if (signal.aborted) close(board);
    } catch (error) {
      close(board);
      throw error;
    }
  };
  const release = (board: Board) => {
    board.busy = false;
    board.lastUsed = ++useSequence;
    wake();
  };
  const wait = async (ms: number) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await raceAbort(
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, ms);
        }),
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
    }
  };
  const attempt = async (
    board: Board,
    child: Job,
    budgetMs: number,
    warm: Result | undefined,
    accept: (entry: SheetEntry, signal: AbortSignal) => Promise<boolean | undefined>,
    onElapsed?: (elapsed: number) => void,
  ): Promise<boolean> => {
    let budget = Math.min(budgetMs, options.deadline - performance.now());
    if (stopped()) return false;
    if (budget < 50 && !onElapsed) {
      await raceAbort(new Promise<void>(() => {}), controller.signal);
      return false;
    }
    if (!(await acquire(board.locked))) return false;
    if (!board.locked && board.pauseRequested) {
      releasePermit();
      return false;
    }
    const local = new AbortController();
    board.local = local;
    const abort = () => local.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      await open(board, local.signal);
    } catch (error) {
      board.local = undefined;
      controller.signal.removeEventListener('abort', abort);
      release(board);
      releasePermit();
      if (local.signal.aborted) return false;
      throw error;
    }
    budget = Math.min(budgetMs, options.deadline - performance.now());
    if (
      stopped() ||
      local.signal.aborted ||
      budget <= 0 ||
      (!board.locked && board.pauseRequested)
    ) {
      if (stopped()) close(board);
      board.local = undefined;
      controller.signal.removeEventListener('abort', abort);
      release(board);
      releasePermit();
      return false;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let version = board.version;
    let active = true;
    let accepted = false;
    let queue: Promise<void> = Promise.resolve();
    const current = () =>
      active &&
      !stopped() &&
      !local.signal.aborted &&
      boards.includes(board) &&
      board.version === version;
    const offer = (candidate: Result) => {
      if (!current() || candidate.sheets || candidate.unplaced) return;
      const copy = structuredClone(candidate);
      queue = queue.then(async () => {
        if (!current()) return;
        const checked = await check(child, copy, local.signal);
        if (!current() || checked?.status !== 'passed') return;
        if (await accept({ job: child, result: { ...copy, validation: checked } }, local.signal)) {
          accepted = true;
          version = board.version;
          board.solve.acceptCandidate?.(structuredClone(board.result));
        }
      });
      // Offers may outlive a solver that rejects or ignores cancellation.
      void queue.catch(() => {});
    };
    let solving: Promise<Result | undefined> | undefined;
    let solveStarted: number | undefined;
    let elapsedRecorded = false;
    let settled = false;
    const recordElapsed = () => {
      if (solveStarted === undefined || elapsedRecorded) return;
      elapsedRecorded = true;
      onElapsed?.(Math.max(0, performance.now() - solveStarted));
    };
    local.signal.addEventListener('abort', recordElapsed, { once: true });
    try {
      solving = Promise.resolve().then(async () => {
        if (local.signal.aborted || stopped()) return undefined;
        const input = structuredClone(child);
        const initialResult = warm && structuredClone(warm);
        budget = Math.min(budgetMs, options.deadline - performance.now());
        solveStarted = performance.now();
        timeout = setTimeout(abort, budget);
        try {
          return await board.solve(input, local.signal, offer, budget, initialResult);
        } finally {
          settled = true;
          recordElapsed();
        }
      });
      const result = await raceAbort(solving, local.signal);
      if (result) offer(result);
      await raceAbort(queue, local.signal);
      return accepted;
    } catch (error) {
      if (
        isInitialPlacementFailure(error) ||
        (warm &&
          /^(Warm start insertion failed:|Invalid initial placement|Initial placement)/.test(
            error instanceof Error ? error.message : String(error),
          ))
      )
        return accepted;
      throw error;
    } finally {
      active = false;
      local.abort();
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abort);
      let hardStop: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!stopped()) {
          if (board.solve.waitForIdle) {
            await raceAbort(board.solve.waitForIdle(), controller.signal);
          } else if (solving && !settled && solveStarted !== undefined) {
            const idle = solving.then(
              () => {},
              () => {},
            );
            const hardDeadline = solveStarted + budget + 100;
            const expiry = new Promise<void>((resolve) => {
              hardStop = setTimeout(
                () => {
                  if (!settled) close(board);
                  resolve();
                },
                Math.max(0, hardDeadline - performance.now()),
              );
            });
            await raceAbort(Promise.race([idle, expiry]), controller.signal);
          }
        }
      } finally {
        clearTimeout(hardStop);
        local.signal.removeEventListener('abort', recordElapsed);
        if (stopped()) close(board);
        board.local = undefined;
        release(board);
        releasePermit();
      }
    }
  };
  const removeCopy = (board: Board, id: string): SheetEntry => {
    const entry = structuredClone({ job: board.job, result: board.result });
    const highest = Math.max(
      ...entry.result.placements.filter((p) => p.partId === id).map((p) => p.copyIndex),
    );
    entry.result.placements = entry.result.placements.filter(
      (p) => p.partId !== id || p.copyIndex !== highest,
    );
    const indices = new Map<string, number>();
    for (const placement of entry.result.placements) {
      placement.copyIndex = indices.get(placement.partId) ?? 0;
      indices.set(placement.partId, placement.copyIndex + 1);
    }
    entry.job.parts = entry.job.parts
      .map((part) => (part.id === id ? { ...part, quantity: part.quantity - 1 } : part))
      .filter((part) => part.quantity > 0);
    return entry;
  };
  const insert = async (target: Board, id: string, source?: Board) => {
    const quantities = new Map(target.job.parts.map((part) => [part.id, part.quantity]));
    quantities.set(id, (quantities.get(id) ?? 0) + 1);
    const child = {
      ...target.job,
      parts: job.parts
        .filter((part) => quantities.has(part.id))
        .map((part) => ({ ...part, quantity: quantities.get(part.id)! })),
    };
    const versions = new Map([[target, target.version]]);
    if (source) versions.set(source, source.version);
    const accept = async (entry: SheetEntry, signal: AbortSignal) => {
      const changes = new Map([[target, entry]]);
      if (source) changes.set(source, removeCopy(source, id));
      const accepted = await commit(changes, versions, signal);
      if (accepted) {
        target.failures = 0;
        target.compressionElapsed = 0;
        if (source) {
          source.failures = 0;
          source.compressionElapsed = 0;
        }
      }
      return accepted;
    };
    return (
      (await attempt(target, child, 10_000, target.result, accept)) ||
      (!stopped() && (await attempt(target, child, 2500, undefined, accept)))
    );
  };
  const lock = async (board: Board) => {
    board.pauseRequested = true;
    board.local?.abort();
    if (board.task) await raceAbort(board.task, controller.signal);
    board.locked = true;
  };
  const unlock = (board: Board) => {
    board.locked = false;
    board.pauseRequested = false;
    wake();
  };
  const fill = async (target: Board, initialization: boolean) => {
    await lock(target);
    try {
      if (stopped() || !boards.includes(target)) return;
      progress(target);
      let added = false;
      const pending = [...(best.unplaced ?? [])].sort(
        (a, b) =>
          job.parts.find((p) => p.id === b.partId)!.priority -
          job.parts.find((p) => p.id === a.partId)!.priority,
      );
      for (const part of pending) {
        for (let n = 0; n < part.quantity && !stopped(); n++) {
          if (!(await insert(target, part.partId))) break;
          added = true;
        }
      }
      const sources = boards.slice(boards.indexOf(target) + 1).reverse();
      for (const source of sources) {
        if (stopped()) break;
        await lock(source);
        try {
          if (stopped() || !boards.includes(source)) continue;
          const types = [...source.job.parts].sort((a, b) => b.priority - a.priority);
          for (const part of types) {
            while (
              !stopped() &&
              boards.includes(source) &&
              source.job.parts.some((p) => p.id === part.id)
            ) {
              if (!(await insert(target, part.id, source))) break;
              added = true;
            }
          }
        } finally {
          unlock(source);
        }
      }
      if (!initialization && !added && !stopped()) target.failures++;
    } finally {
      unlock(target);
    }
  };
  const compress = async (board: Board) => {
    progress(board);
    await attempt(
      board,
      board.job,
      Math.max(0, compressionMs - board.compressionElapsed),
      board.result,
      async (entry, signal) => {
        if (entry.result.usedLengthMm >= board.result.usedLengthMm) return false;
        return commit(new Map([[board, entry]]), new Map([[board, board.version]]), signal);
      },
      (elapsed) => {
        board.compressionElapsed += elapsed;
      },
    );
  };
  const queued = new Map<Board, boolean>();
  let processor: Promise<void> | undefined;
  let failure: unknown;
  const enqueue = (board: Board, initialization = false) => {
    if (!boards.includes(board) || stopped() || queued.has(board)) return;
    queued.set(board, initialization);
    if (processor) return;
    processor = Promise.resolve()
      .then(async () => {
        while (queued.size && !stopped()) {
          const target = boards.find((board) => queued.has(board));
          if (!target) {
            queued.clear();
            break;
          }
          const initialFill = queued.get(target)!;
          // Keep the request present while processing so a slice cannot duplicate it.
          try {
            if (initialFill || target.failures < limit) await fill(target, initialFill);
          } finally {
            if (initialFill) target.initialized = true;
            queued.delete(target);
            wake();
          }
        }
      })
      .catch((error) => {
        failure = error;
        stop();
      })
      .finally(() => {
        processor = undefined;
        wake();
      });
  };
  const loop = async (board: Board) => {
    while (!stopped() && boards.includes(board)) {
      const singleComplete = boards.length === 1 && !best.unplaced?.length;
      if (singleComplete) board.initialized = true;
      if (!board.initialized) {
        await changed();
        continue;
      }
      if (board.pauseRequested || board.locked || (!singleComplete && board.failures >= limit)) {
        await changed();
        continue;
      }
      board.task = compress(board);
      try {
        await board.task;
      } finally {
        board.task = undefined;
        wake();
      }
      if (stopped() || !boards.includes(board)) break;
      if (board.compressionElapsed >= compressionMs) {
        board.compressionElapsed = 0;
        roundIndex++;
        if (!(boards.length === 1 && !best.unplaced?.length) && board.failures < limit)
          enqueue(board);
      }
      await wait(10);
    }
  };
  try {
    if (stopped()) return best;
    for (const entry of best.sheets ?? []) {
      if (entry.job.parts.some((part) => part.quantity > 0))
        boards.push({
          ...structuredClone(entry),
          solve: create(),
          opened: false,
          busy: false,
          locked: false,
          pauseRequested: false,
          lastUsed: 0,
          version: 0,
          failures: 0,
          compressionElapsed: 0,
          initialized: boards.length !== 0,
          lastImprovementAt: performance.now(),
        });
    }
    if (!(boards.length === 1 && !best.unplaced?.length))
      for (const board of boards) enqueue(board, true);
    else if (boards[0]) boards[0].initialized = true;
    const loops = boards.map((board) =>
      loop(board).catch((error) => {
        failure = error;
        stop();
      }),
    );
    while (!stopped() && boards.length) {
      if (
        !(boards.length === 1 && !best.unplaced?.length) &&
        boards.every((board) => board.failures >= limit) &&
        !queued.size &&
        !processor
      )
        break;
      await changed();
    }
    stop();
    await Promise.all(loops);
    if (processor) await processor;
    if (failure) throw failure;
    return structuredClone(best);
  } finally {
    stop();
    for (const board of boards) close(board);
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
  }
}
