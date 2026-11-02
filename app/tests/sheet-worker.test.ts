import { afterEach, expect, it, vi } from 'vitest';
import { sheetStripSolver } from '../src/engine/workers/sheetSolver';
import { DEFAULT_SETTINGS, newPart, type Job, type Result } from '../src/engine/model';
import { solverInput } from '../src/engine/import/sparrow';

const input: Job = {
  name: 'worker',
  settings: { ...DEFAULT_SETTINGS, timeLimitSeconds: 10 },
  parts: [
    newPart([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]),
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('maps warm placements by stable part ID when the child adds a new type', async () => {
  const job = structuredClone(input);
  const old = job.parts[0];
  job.parts.unshift({
    ...newPart([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ]),
    quantity: 1,
  });
  job.settings.sheetLengthMm = 100;
  const initial: Result = {
    documentRevision: 1,
    solverRevision: 'test',
    seed: '1',
    elapsedSeconds: 0,
    usedLengthMm: 30,
    placements: [{ partId: old.id, copyIndex: 0, xMm: 20, yMm: 5, angleDeg: 90 }],
    validation: {
      status: 'passed',
      overlapAreaMm2: 0,
      maxBoundaryViolationMm: 0,
      minClearanceMm: null,
      errors: [],
    },
  };
  const serialized = JSON.parse(solverInput(job, initial));
  expect(serialized.stock_length).toBe(100);
  expect(serialized.initial_placement).toEqual({
    used_length_mm: 30,
    placements: [{ item_id: 1, rotation: 90, translation: [20, 5] }],
  });
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: { type: string; initialPlacement?: Result }) {
      if (message.type !== 'start') return;
      expect(message.initialPlacement).toEqual(initial);
      queueMicrotask(() =>
        this.onmessage!({ data: { type: 'finished', runId: 1, documentRevision: 1 } }),
      );
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  await sheetStripSolver(1)(job, undefined, undefined, 100, initial);
});

it.each([
  'Warm start insertion failed: no room',
  'Initial placement collides with parts or stock boundaries',
])('treats a rejected warm start as a recoverable attempt: %s', async (message) => {
  const initial: Result = {
    documentRevision: 1,
    solverRevision: 'test',
    seed: '1',
    elapsedSeconds: 0,
    usedLengthMm: 10,
    placements: [{ partId: input.parts[0].id, copyIndex: 0, xMm: 0, yMm: 0, angleDeg: 0 }],
    validation: {
      status: 'passed',
      overlapAreaMm2: 0,
      maxBoundaryViolationMm: 0,
      minClearanceMm: null,
      errors: [],
    },
  };
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(data: { type: string }) {
      if (data.type === 'start')
        queueMicrotask(() =>
          this.onmessage!({ data: { type: 'error', runId: 1, documentRevision: 1, message } }),
        );
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  await expect(
    sheetStripSolver(1)(input, undefined, undefined, 100, initial),
  ).resolves.toBeUndefined();
});

it('sends immediate stop to the coordinator and ignores late worker messages', async () => {
  vi.useFakeTimers();
  const posted: unknown[] = [];
  let worker: MockWorker;
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { message: string }) => void;
    constructor() {
      worker = this;
    }
    postMessage(message: unknown) {
      posted.push(message);
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  const controller = new AbortController();
  const pending = sheetStripSolver(1)(input, controller.signal);
  controller.abort();
  await expect(pending).resolves.toBeUndefined();
  expect(posted).toHaveLength(2);
  expect(posted[1]).toEqual({ type: 'stop' });
  worker!.onmessage!({ data: { type: 'error', runId: 1, documentRevision: 1, message: 'late' } });
  await vi.advanceTimersByTimeAsync(25_000);
  expect(posted).toHaveLength(2);
  await expect(sheetStripSolver(1)(input, controller.signal)).resolves.toBeUndefined();
  expect(posted).toHaveLength(2);
});

it.each(
  (['sparrow', 'narrow'] as const).flatMap((route) =>
    (['deadline', 'abort', 'finished', 'error'] as const).map((end) => ({ route, end })),
  ),
)('cleans up $route polygon attempts on $end and ignores late messages', async ({ route, end }) => {
  vi.useFakeTimers();
  const workers: MockWorker[] = [];
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { message: string }) => void;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() {
      workers.push(this);
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  const job = structuredClone(input);
  job.settings.sheetStock = {
    id: 'polygon',
    name: 'polygon',
    kind: 'polygon',
    widthMm: 20,
    lengthMm: 20,
    quantity: 1,
    priority: 0,
    outer: [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ],
    holes: [],
  };
  job.settings.materialWidthMm = 20;
  job.settings.sheetLengthMm = 20;
  if (route === 'narrow') job.settings.clearanceMm = 20;
  const controller = new AbortController();
  const onCandidate = vi.fn();
  const pending = sheetStripSolver(7)(job, controller.signal, onCandidate, 100);
  const settled =
    end === 'error'
      ? expect(pending).rejects.toThrow('broken')
      : expect(pending).resolves.toBeUndefined();
  const worker = workers[0];
  if (end === 'deadline') await vi.advanceTimersByTimeAsync(100);
  if (end === 'abort') controller.abort();
  if (end === 'finished')
    worker.onmessage!({ data: { type: 'finished', runId: 1, documentRevision: 7 } });
  if (end === 'error') worker.onerror!({ message: 'broken' });
  await settled;
  expect(worker.terminate).toHaveBeenCalledTimes(route === 'narrow' ? 1 : 0);
  expect(worker.postMessage).toHaveBeenCalledTimes(route === 'narrow' ? 1 : 2);
  if (route === 'sparrow') expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'stop' });
  worker.onmessage!({ data: { type: 'candidate', result: { usedLengthMm: 1 } } });
  worker.onmessage!({ data: { type: 'error', message: 'late' } });
  worker.onerror!({ message: 'late' });
  controller.abort();
  await vi.advanceTimersByTimeAsync(1000);
  expect(onCandidate).not.toHaveBeenCalled();
  expect(worker.terminate).toHaveBeenCalledTimes(route === 'narrow' ? 1 : 0);
  expect(worker.postMessage).toHaveBeenCalledTimes(route === 'narrow' ? 1 : 2);
  await expect(sheetStripSolver(7)(job, controller.signal)).resolves.toBeUndefined();
  expect(workers).toHaveLength(1);
});

it.each(['rectangle', 'polygon', 'implicit'] as const)(
  'routes narrow %s stock to the polygon worker without changing gap or stock',
  async (kind) => {
    class MockWorker {
      static url: URL;
      static start: { job: Job };
      onmessage?: (event: { data: unknown }) => void;
      terminate = vi.fn();
      constructor(url: URL) {
        MockWorker.url = url;
      }
      postMessage(message: { job: Job }) {
        MockWorker.start = message;
        queueMicrotask(() => this.onmessage!({ data: { type: 'finished' } }));
      }
    }
    vi.stubGlobal('Worker', MockWorker);
    const job = structuredClone(input);
    job.settings.sheetStock = {
      id: 'narrow',
      name: 'narrow',
      kind: 'rectangle',
      widthMm: 5,
      lengthMm: 10,
      quantity: 1,
      priority: 1,
    };
    if (kind === 'polygon')
      job.settings.sheetStock = {
        ...job.settings.sheetStock,
        kind: 'polygon',
        outer: [
          [0, 0],
          [5, 0],
          [5, 10],
          [0, 10],
        ],
        holes: [],
      };
    if (kind === 'implicit') delete job.settings.sheetStock;
    job.settings.materialWidthMm = 5;
    job.settings.sheetLengthMm = 10;
    job.settings.clearanceMm = 10;
    await sheetStripSolver(1)(job);
    expect(MockWorker.url.pathname).toContain('polygon.worker.ts');
    expect(MockWorker.start.job).toEqual(job);
  },
);

it('sends real polygon stock holes without inserting stock into the item ID mapping', async () => {
  const job = structuredClone(input);
  job.parts.unshift({
    ...newPart([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]),
    quantity: 0,
  });
  job.settings.sheetStock = {
    id: 'cut-stock',
    name: 'cut-stock',
    kind: 'polygon',
    widthMm: 40,
    lengthMm: 50,
    quantity: 1,
    priority: 0,
    outer: [
      [0, 0],
      [40, 0],
      [40, 50],
      [0, 50],
    ],
    holes: [
      [
        [20, 20],
        [25, 20],
        [25, 25],
        [20, 25],
      ],
    ],
  };
  job.settings.materialWidthMm = 40;
  const serialized = JSON.parse(solverInput(job));
  expect(serialized.stock_geometry).toEqual({
    outer: job.settings.sheetStock.outer,
    holes: job.settings.sheetStock.holes,
  });
  expect(serialized.items).toHaveLength(1);
  expect(serialized.items[0]).toMatchObject({
    id: 0,
    demand: 1,
    shape: { data: job.parts[1].outer },
  });
  const urls: URL[] = [];
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    constructor(url: URL) {
      urls.push(url);
    }
    postMessage(message: { type: string; document?: Job; threads?: number }) {
      if (message.type !== 'start') return;
      expect(message.document).toEqual(job);
      expect(message.threads).toBe(2);
      queueMicrotask(() => {
        for (const [sequence, length] of [10, 20, 10].entries()) {
          this.onmessage!({
            data: {
              type: 'candidate',
              runId: 1,
              documentRevision: 9,
              sequence,
              elapsedMs: 1,
              report: '',
              solution: {
                strip_width: length,
                layout: {
                  placed_items: [
                    { item_id: 0, transformation: { rotation: 0, translation: [sequence, 0] } },
                  ],
                },
              },
            },
          });
        }
        this.onmessage!({ data: { type: 'finished', runId: 1, documentRevision: 9 } });
      });
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  const candidates: Result[] = [];
  const result = await sheetStripSolver(9, 2)(job, undefined, (candidate) =>
    candidates.push(candidate),
  );
  expect(urls[0].pathname).toContain('solver.worker.ts');
  expect(candidates.map((candidate) => candidate.usedLengthMm)).toEqual([10, 20, 10]);
  expect(candidates.every((candidate) => candidate.placements[0].partId === job.parts[1].id)).toBe(
    true,
  );
  expect(result).toBe(candidates[0]);
  delete job.settings.sheetStock;
  expect(JSON.parse(solverInput(job))).not.toHaveProperty('stock_geometry');
});
