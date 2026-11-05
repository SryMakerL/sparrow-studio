import type { Job, Result } from '../model';
import { SOLVER_REVISION } from '../model';
import type { Candidate, SolverMessage } from './protocol';
import { SheetWorkerSession } from './sheetSession';
import { isInitialPlacementFailure, type StripAttempt } from '../sheets';

export function sheetStripSolver(revision: number, threads?: number): StripAttempt {
  let session: SheetWorkerSession | undefined;
  const attempt: StripAttempt = (
    job: Job,
    signal?: AbortSignal,
    onCandidate?: (result: Result) => void,
    attemptBudgetMs?: number,
    initialPlacement?: Result,
  ) =>
    session
      ? session.attempt(job, signal, onCandidate, attemptBudgetMs, initialPlacement)
      : // Sparrow's strip inset requires positive width after clearance; retain the
        // geometry fallback for every stock kind until narrow-stock gap semantics exist.
        job.settings.materialWidthMm <= job.settings.clearanceMm
        ? polygonAttempt(job, revision, signal, onCandidate, attemptBudgetMs, initialPlacement)
        : new Promise<Result | undefined>((resolve, reject) => {
            if (signal?.aborted) {
              resolve(undefined);
              return;
            }
            const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), {
              type: 'module',
            });
            const seed = crypto.getRandomValues(new BigUint64Array(1))[0].toString();
            let best: Result | undefined,
              done = false;
            const finish = (error?: string) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              signal?.removeEventListener('abort', abort);
              worker.postMessage({ type: 'stop' });
              const warmFailure =
                !!initialPlacement &&
                !!error &&
                /^(Warm start insertion failed:|Invalid initial placement|Initial placement)/.test(
                  error,
                );
              if (error && !isInitialPlacementFailure(error) && !warmFailure) reject(Error(error));
              else resolve(error ? undefined : best);
            };
            const abort = () => finish();
            // Includes WASM startup and a hard deadline even for non-cooperative solver iterations.
            const timer = setTimeout(() => finish(), Math.min(25_000, attemptBudgetMs ?? Infinity));
            signal?.addEventListener('abort', abort, { once: true });
            worker.onmessage = ({ data }: MessageEvent<SolverMessage>) => {
              if (done || signal?.aborted) return;
              if (data.runId !== 1 || data.documentRevision !== revision) return;
              if (data.type === 'candidate') {
                const result = fromCandidate(job, data, seed);
                if (!best || result.usedLengthMm < best.usedLengthMm) best = result;
                onCandidate?.(result);
              }
              if (data.type === 'finished') finish();
              if (data.type === 'error') finish(data.message);
            };
            worker.onerror = (event) => finish(event.message || 'Sheet solver worker failed.');
            worker.postMessage({
              type: 'start',
              runId: 1,
              documentRevision: revision,
              document: job,
              initialPlacement,
              seed,
              threads,
            });
          });
  attempt.beginSheet = async (catalog, signal) => {
    session?.close();
    session =
      catalog.settings.materialWidthMm > catalog.settings.clearanceMm
        ? new SheetWorkerSession(catalog, revision, threads)
        : undefined;
    await session?.open(signal);
  };
  attempt.endSheet = () => {
    session?.close();
    session = undefined;
  };
  attempt.waitForIdle = () => session?.waitForIdle() ?? Promise.resolve();
  attempt.acceptCandidate = (result) => session?.accept(result);
  attempt.forkSheet = () => sheetStripSolver(revision, threads);
  return attempt;
}
function polygonAttempt(
  job: Job,
  revision: number,
  signal?: AbortSignal,
  onCandidate?: (result: Result) => void,
  budgetMs = 2500,
  initialPlacement?: Result,
): Promise<Result | undefined> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve(undefined);
      return;
    }
    const worker = new Worker(new URL('./polygon.worker.ts', import.meta.url), { type: 'module' });
    let best: Result | undefined,
      done = false;
    const finish = (error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(Error(error));
      else resolve(best);
    };
    const abort = () => finish();
    const timer = setTimeout(finish, budgetMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (done) return;
      if (data.type === 'candidate') {
        const result = { ...data.result, documentRevision: revision };
        if (!best || result.usedLengthMm < best.usedLengthMm) best = result;
        onCandidate?.(result);
      }
      if (data.type === 'finished') finish();
      if (data.type === 'error') finish(data.message);
    };
    worker.onerror = (event) => finish(event.message);
    worker.postMessage({
      type: 'start',
      job,
      budgetMs: Math.max(0, budgetMs - 20),
      initialPlacement,
    });
  });
}
function fromCandidate(job: Job, candidate: Candidate, seed: string): Result {
  const parts = job.parts.filter((p) => p.quantity > 0),
    copies = new Map<string, number>();
  return {
    documentRevision: candidate.documentRevision,
    solverRevision: SOLVER_REVISION,
    seed,
    elapsedSeconds: candidate.elapsedMs / 1000,
    usedLengthMm: candidate.solution.strip_width,
    placements: candidate.solution.layout.placed_items.map((p) => {
      const partId = parts[p.item_id]?.id ?? 'unknown',
        copyIndex = copies.get(partId) ?? 0;
      copies.set(partId, copyIndex + 1);
      return {
        partId,
        copyIndex,
        xMm: p.transformation.translation[0],
        yMm: p.transformation.translation[1],
        angleDeg: p.transformation.rotation,
      };
    }),
    validation: {
      status: 'pending',
      overlapAreaMm2: null,
      maxBoundaryViolationMm: null,
      minClearanceMm: null,
      errors: [],
    },
  };
}
