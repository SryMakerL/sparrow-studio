import type { Job, Result, SheetStock } from './model';
import type { SheetEntry } from './sheets';

export type BoardCandidate = SheetEntry & {
  stock: SheetStock;
  taskId: number;
};

export type BoardCandidateTask = {
  taskId: number;
  stock: SheetStock;
  remaining: Map<string, number>;
  signal: AbortSignal;
};

export type BoardCandidateSchedulerOptions = {
  concurrency?: number;
  signal?: AbortSignal;
  stocks: SheetStock[];
  parts: Job['parts'];
  generate: (task: BoardCandidateTask) => Promise<SheetEntry | undefined>;
  score?: (candidate: BoardCandidate) => readonly number[];
  onCommit?: (candidate: BoardCandidate, remaining: ReadonlyMap<string, number>) => void;
};

export type BoardCandidateSchedulerResult = {
  sheets: BoardCandidate[];
  remaining: Map<string, number>;
};

const defaultScore = (candidate: BoardCandidate): readonly number[] => [
  -candidate.job.parts.reduce((sum, part) => sum + part.quantity, 0),
  -candidate.stock.priority,
  candidate.result.usedLengthMm,
  candidate.taskId,
];

function compare(
  left: BoardCandidate,
  right: BoardCandidate,
  score: (candidate: BoardCandidate) => readonly number[],
): number {
  const a = score(left);
  const b = score(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function demand(candidate: SheetEntry): Map<string, number> {
  const result = new Map<string, number>();
  for (const part of candidate.job.parts) {
    result.set(part.id, (result.get(part.id) ?? 0) + part.quantity);
  }
  return result;
}

function canCommit(candidate: SheetEntry, remaining: ReadonlyMap<string, number>): boolean {
  for (const [partId, quantity] of demand(candidate)) {
    if (quantity <= 0 || quantity > (remaining.get(partId) ?? 0)) return false;
  }
  return true;
}

function commit(candidate: SheetEntry, remaining: Map<string, number>): void {
  for (const [partId, quantity] of demand(candidate)) {
    remaining.set(partId, remaining.get(partId)! - quantity);
  }
}

/**
 * Runs independent board searches against immutable remaining-pool snapshots.
 * Only this coordinator mutates the pool, so stale candidates cannot double-spend parts.
 */
export async function scheduleBoardCandidates(
  options: BoardCandidateSchedulerOptions,
): Promise<BoardCandidateSchedulerResult> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const score = options.score ?? defaultScore;
  const remaining = new Map(options.parts.map((part) => [part.id, part.quantity]));
  const sheets: BoardCandidate[] = [];
  const pending = options.stocks.map((stock) => ({ stock }));
  let nextTaskId = 0;
  let stopped = options.signal?.aborted ?? false;
  const controllers = new Set<AbortController>();
  const stop = () => {
    stopped = true;
    for (const controller of controllers) controller.abort();
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    while (!stopped && pending.length && [...remaining.values()].some(Boolean)) {
      const batch = pending.splice(0, concurrency);
      const candidates = (
        await Promise.all(
          batch.map(async ({ stock }) => {
            const taskId = nextTaskId++;
            const controller = new AbortController();
            controllers.add(controller);
            const abort = () => controller.abort();
            options.signal?.addEventListener('abort', abort, { once: true });
            try {
              const entry = await options.generate({
                taskId,
                stock,
                remaining: new Map(remaining),
                signal: controller.signal,
              });
              return entry ? { ...entry, stock, taskId } : undefined;
            } finally {
              controllers.delete(controller);
              options.signal?.removeEventListener('abort', abort);
            }
          }),
        )
      ).filter((candidate): candidate is BoardCandidate => !!candidate);
      if (stopped) break;
      const winner = candidates
        .filter((candidate) => canCommit(candidate, remaining))
        .sort((a, b) => compare(a, b, score))[0];
      if (!winner) continue;
      commit(winner, remaining);
      sheets.push(winner);
      options.onCommit?.(winner, new Map(remaining));
    }
  } finally {
    stop();
    options.signal?.removeEventListener('abort', stop);
  }

  return { sheets, remaining };
}

export function resultFromBoardCandidates(
  job: Job,
  candidates: readonly BoardCandidate[],
  remaining: ReadonlyMap<string, number>,
): Result {
  return {
    documentRevision: 0,
    solverRevision: '',
    seed: candidates[0]?.result.seed ?? '',
    elapsedSeconds: candidates.reduce(
      (max, candidate) => Math.max(max, candidate.result.elapsedSeconds),
      0,
    ),
    usedLengthMm: candidates.reduce((sum, candidate) => sum + candidate.result.usedLengthMm, 0),
    placements: [],
    sheets: candidates.map(({ job: sheetJob, result }) => ({ job: sheetJob, result })),
    unplaced: job.parts
      .filter((part) => (remaining.get(part.id) ?? 0) > 0)
      .map((part) => ({ partId: part.id, quantity: remaining.get(part.id)! })),
    validation: {
      status: 'passed',
      overlapAreaMm2: 0,
      maxBoundaryViolationMm: 0,
      minClearanceMm: null,
      errors: [],
    },
  };
}
