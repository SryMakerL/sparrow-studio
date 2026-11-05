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
  lastUsed: number;
  version: number;
  failures: number;
  lastImprovementAt: number;
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
  const open = async (board: Board) => {
    if (stopped()) return;
    board.busy = true;
    board.lastUsed = ++useSequence;
    if (board.opened) return;
    if (boards.filter((entry) => entry.opened).length >= concurrency) {
      const idle = boards
        .filter((entry) => entry.opened && !entry.busy)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) {
        board.busy = false;
        throw Error('No idle board session is available within the CPU budget.');
      }
      close(idle);
    }
    board.opened = true;
    try {
      await raceAbort(
        Promise.resolve().then(() =>
          board.solve.beginSheet?.(
            {
              ...structuredClone(job),
              settings: structuredClone(board.job.settings),
            },
            controller.signal,
          ),
        ),
        controller.signal,
      );
    } catch (error) {
      close(board);
      throw error;
    }
  };
  const release = (board: Board) => {
    board.busy = false;
    board.lastUsed = ++useSequence;
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
  ): Promise<boolean> => {
    const budget = Math.min(budgetMs, options.deadline - performance.now());
    if (stopped()) return false;
    if (budget < 50) {
      await raceAbort(new Promise<void>(() => {}), controller.signal);
      return false;
    }
    const local = new AbortController();
    const abort = () => local.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, budget);
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
    try {
      const result = await raceAbort(
        Promise.resolve().then(() =>
          board.solve(
            structuredClone(child),
            local.signal,
            offer,
            budget,
            warm && structuredClone(warm),
          ),
        ),
        local.signal,
      );
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
        if (source) source.failures = 0;
      }
      return accepted;
    };
    return (
      (await attempt(target, child, 10_000, target.result, accept)) ||
      (!stopped() && (await attempt(target, child, 2500, undefined, accept)))
    );
  };
  const fill = async (target: Board) => {
    try {
      await open(target);
      progress(target);
      while (!stopped() && boards.includes(target) && target.failures < limit) {
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
        }
        if (!added) {
          target.failures++;
          break;
        }
        target.failures = 0;
        if (boards.length === 1 && !best.unplaced?.length) break;
      }
    } finally {
      release(target);
    }
  };
  const compress = async (board: Board) => {
    try {
      await open(board);
      progress(board);
      await attempt(board, board.job, compressionMs, board.result, async (entry, signal) => {
        if (entry.result.usedLengthMm >= board.result.usedLengthMm) return false;
        return commit(new Map([[board, entry]]), new Map([[board, board.version]]), signal);
      });
    } finally {
      release(board);
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
          lastUsed: 0,
          version: 0,
          failures: 0,
          lastImprovementAt: performance.now(),
        });
    }
    for (const board of [...boards]) {
      if (stopped()) break;
      if (boards.includes(board)) {
        await fill(board);
        if (boards.includes(board)) board.failures = 0;
      }
    }
    while (!stopped() && boards.length) {
      const singleComplete = boards.length === 1 && !best.unplaced?.length;
      const eligible = boards.filter((board) => singleComplete || board.failures < limit);
      if (!eligible.length) break;
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, eligible.length) }, async () => {
          while (!stopped() && next < eligible.length) await compress(eligible[next++]);
        }),
      );
      if (stopped()) break;
      roundIndex++;
      if (!(boards.length === 1 && !best.unplaced?.length)) {
        for (const board of [...boards]) {
          if (stopped()) break;
          if (boards.includes(board) && board.failures < limit) await fill(board);
        }
      }
      // Naturally completed mocks and solvers must still yield to Stop and deadline timers.
      await wait(Math.min(50, Math.max(0, options.deadline - performance.now())));
    }
    return structuredClone(best);
  } finally {
    stop();
    for (const board of boards) close(board);
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
  }
}
