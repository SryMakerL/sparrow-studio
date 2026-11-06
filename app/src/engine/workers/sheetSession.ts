import type { Job, Result } from '../model';
import { SOLVER_REVISION } from '../model';
import type { Candidate } from './protocol';

const key = (result: Result) =>
  JSON.stringify([result.seed, result.usedLengthMm, result.placements]);

type SessionMessage = {
  type: string;
  runId: number;
  documentRevision: number;
  attemptId?: number;
  snapshotId?: number;
  message?: string;
} & Partial<Omit<Candidate, 'type'>>;

type Pending = {
  id: number;
  seed: string;
  job: Job;
  initial?: Result;
  best?: Result;
  offer?: (result: Result) => void;
  finish: (error?: string) => void;
};

/** Owns one worker tree for one physical sheet; only a hard timeout discards it. */
export class SheetWorkerSession {
  private worker?: Worker;
  private ready?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private pending?: Pending;
  private idle: Promise<void> = Promise.resolve();
  private sequence = 0;
  private generation = 0;
  private snapshots = new Map<string, number>();
  private retained?: number;
  private initializationTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private catalog: Job,
    private revision: number,
    private threads?: number,
  ) {}

  async open(signal?: AbortSignal) {
    if (signal?.aborted) return;
    const ready = this.initialize();
    const abort = () => this.dispose();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await ready;
    } catch (error) {
      if (!signal?.aborted) throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  accept(result: Result) {
    const snapshot = this.snapshots.get(key(result));
    if (snapshot !== undefined) {
      this.retained = snapshot;
    }
  }

  close() {
    this.dispose();
    this.pending?.finish();
  }

  private dispose(error = 'Sheet session closed.') {
    this.generation++;
    clearTimeout(this.initializationTimer);
    this.worker?.postMessage({ type: 'stop' });
    this.worker = undefined;
    this.rejectReady?.(Error(error));
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    this.ready = undefined;
    this.snapshots.clear();
    this.retained = undefined;
  }

  private initialize(): Promise<void> {
    if (this.ready) return this.ready;
    const generation = ++this.generation;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.initializationTimer = setTimeout(() => {
      this.dispose('Sheet session initialization timed out.');
    }, 20_000);
    worker.onmessage = ({ data }: MessageEvent<SessionMessage>) => {
      if (
        generation !== this.generation ||
        data.documentRevision !== this.revision ||
        data.runId !== 1
      )
        return;
      if (data.type === 'session-ready') {
        clearTimeout(this.initializationTimer);
        this.resolveReady?.();
        this.resolveReady = undefined;
        this.rejectReady = undefined;
        return;
      }
      if (data.type === 'error') {
        this.dispose(data.message);
        this.pending?.finish(data.message ?? 'Sheet session worker failed.');
        return;
      }
      const pending = this.pending;
      if (!pending || data.attemptId !== pending.id) return;
      if (data.type === 'candidate' && data.solution && data.snapshotId !== undefined) {
        const copies = new Map<string, number>();
        const result: Result = {
          documentRevision: this.revision,
          solverRevision: SOLVER_REVISION,
          seed: pending.seed,
          elapsedSeconds: (data.elapsedMs ?? 0) / 1000,
          usedLengthMm: data.solution.strip_width,
          placements: data.solution.layout.placed_items.map((placement) => {
            const partId = this.catalog.parts[placement.item_id]?.id ?? 'unknown';
            const copyIndex = copies.get(partId) ?? 0;
            copies.set(partId, copyIndex + 1);
            return {
              partId,
              copyIndex,
              xMm: placement.transformation.translation[0],
              yMm: placement.transformation.translation[1],
              angleDeg: placement.transformation.rotation,
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
        if (!this.snapshots.has(key(result))) this.snapshots.set(key(result), data.snapshotId);
        const compressing =
          !!pending.initial &&
          pending.initial.placements.length ===
            pending.job.parts.reduce((sum, part) => sum + part.quantity, 0);
        if (
          !pending.best ||
          result.usedLengthMm < pending.best.usedLengthMm ||
          (compressing && result.usedLengthMm === pending.best.usedLengthMm)
        )
          pending.best = result;
        pending.offer?.(result);
      }
      if (data.type === 'finished') pending.finish();
      if (data.type === 'attempt-error') pending.finish(data.message);
    };
    worker.onerror = (event) => {
      if (generation !== this.generation) return;
      this.dispose(event.message);
      this.pending?.finish(event.message || 'Sheet session worker failed.');
    };
    worker.postMessage({
      type: 'session-init',
      runId: 1,
      documentRevision: this.revision,
      document: this.catalog,
      threads: this.threads,
    });
    return this.ready;
  }

  async attempt(
    job: Job,
    signal?: AbortSignal,
    offer?: (result: Result) => void,
    budgetMs = 2500,
    initial?: Result,
  ): Promise<Result | undefined> {
    if (signal?.aborted) return;
    await this.idle;
    if (signal?.aborted) return;
    const started = performance.now();
    const ready = this.initialize();
    const abortInitialization = () => this.dispose();
    signal?.addEventListener('abort', abortInitialization, { once: true });
    try {
      await ready;
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    } finally {
      signal?.removeEventListener('abort', abortInitialization);
    }
    if (signal?.aborted || !this.worker) return;
    const remaining = budgetMs - (performance.now() - started);
    if (remaining < 20) return;
    const initialSnapshot = initial ? this.snapshots.get(key(initial)) : undefined;
    // An expired hard-timeout session must restart cold, never import rounded coordinates.
    const keep = new Set([initialSnapshot, this.retained]);
    this.snapshots = new Map([...this.snapshots].filter(([, snapshot]) => keep.has(snapshot)));
    let markIdle!: () => void;
    this.idle = new Promise<void>((resolve) => {
      markIdle = resolve;
    });
    return new Promise<Result | undefined>((resolve, reject) => {
      const id = ++this.sequence;
      const seed = crypto.getRandomValues(new BigUint64Array(1))[0].toString();
      let finished = false;
      const finish = (error?: string) => {
        if (finished) return;
        finished = true;
        markIdle();
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        const best = this.pending?.id === id ? this.pending.best : undefined;
        if (this.pending?.id === id) this.pending = undefined;
        if (
          error &&
          !/^(Warm start insertion failed:|No valid initial placement|Invalid initial|Initial placement)/.test(
            error,
          )
        )
          reject(Error(error));
        else resolve(error ? undefined : best);
      };
      const abort = () => {
        this.worker?.postMessage({ type: 'session-cancel', attemptId: id });
        // Search steps return immediately after construction. Compression uses a soft interrupt;
        // the watchdog remains armed until Rust has returned to its event loop.
      };
      const timer = Number.isFinite(remaining)
        ? setTimeout(() => {
            this.dispose();
            finish();
          }, remaining + 100)
        : undefined;
      this.pending = { id, seed, job, initial, offer, finish };
      signal?.addEventListener('abort', abort, { once: true });
      const quantities = new Map(job.parts.map((part) => [part.id, part.quantity]));
      this.worker!.postMessage({
        type: 'session-step',
        runId: 1,
        documentRevision: this.revision,
        attemptId: id,
        seed,
        quantities: this.catalog.parts.map((part) => quantities.get(part.id) ?? 0),
        initialSnapshot,
        retainSnapshot: this.retained,
        mode:
          initial &&
          initial.placements.length === job.parts.reduce((sum, part) => sum + part.quantity, 0)
            ? 'compress'
            : 'search',
        budgetMs: Number.isFinite(remaining) ? Math.max(1, remaining - 100) : null,
      });
    });
  }
}
