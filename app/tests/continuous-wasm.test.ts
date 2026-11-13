import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { validate, netArea } from '../src/engine/geometry/validate';
import { solverInput } from '../src/engine/import/sparrow';
import { DEFAULT_SETTINGS, newPart, type Job, type Result, type Ring } from '../src/engine/model';

type Candidate = {
  type: 'candidate';
  snapshotId: number;
  solution: {
    strip_width: number;
    layout: { placed_items: {
      item_id: number;
      transformation: { rotation: number; translation: [number, number] };
    }[] };
  };
};
type Message = Candidate | { type: 'phase'; phase: string } | { type: 'finished' };
type Event = { atMs: number; message: Message };
type Request = {
  quantities: number[];
  mode: 'search' | 'compress' | 'continuous';
  budget_ms: number;
  initial_snapshot?: number;
  retain_snapshot?: number;
};
type Stage = { label: string; wallMs: number; request: Request; events: Event[] };
type Report = {
  constructors: number;
  constructorMs?: number;
  stages: Stage[];
  logs: { stage: string; line: string }[];
  error?: string;
  timedOut?: boolean;
};
const seed = '4242';
const budgetMs = 1000;
const slices = 4;
const root = resolve(import.meta.dirname, '../..');
const candidates = (stage: Stage) => stage.events.flatMap(({ message }) =>
  message.type === 'candidate' ? [message] : [],
);
const best = (stage: Stage) => candidates(stage).reduce((a, b) =>
  b.solution.strip_width < a.solution.strip_width ? b : a,
);

function fixture(): Job {
  const rings: Ring[] = [
    [[0, 0], [24, 0], [24, 8], [10, 8], [10, 20], [0, 20]],
    [[0, 0], [18, 0], [18, 12], [0, 12]],
  ];
  return {
    name: 'continuous mixed catalog20',
    parts: rings.map((ring, i) => ({
      ...newPart(ring), id: `continuous-part-${i}`, quantity: 10,
      rotations: { kind: 'discrete', degrees: [0, 90, 180, 270] },
    })),
    settings: {
      ...DEFAULT_SETTINGS, solverPreset: 'fast', clearanceMm: 1,
      materialWidthMm: 100, sheetLengthMm: 500,
      sheetStock: {
        id: 'continuous-stock', name: 'large rectangular stock', kind: 'rectangle',
        quantity: 1, priority: 0, widthMm: 100, lengthMm: 500,
      },
    },
  };
}

function asResult(job: Job, candidate: Candidate): Result {
  const copies = new Map<number, number>();
  return {
    documentRevision: 0, solverRevision: 'continuous-wasm-regression', seed,
    elapsedSeconds: 0, usedLengthMm: candidate.solution.strip_width,
    placements: candidate.solution.layout.placed_items.map(item => {
      const copyIndex = copies.get(item.item_id) ?? 0;
      copies.set(item.item_id, copyIndex + 1);
      return {
        partId: job.parts[item.item_id].id, copyIndex,
        angleDeg: item.transformation.rotation,
        xMm: item.transformation.translation[0], yMm: item.transformation.translation[1],
      };
    }),
    validation: {
      status: 'pending', overlapAreaMm2: 0, maxBoundaryViolationMm: 0,
      minClearanceMm: null, errors: [],
    },
  };
}

function isolated(pkg: string, job: Job): Promise<Report> {
  // The regular cold strip serializer omits stock_length; SheetSession requires finite stock.
  const input = JSON.stringify({ ...JSON.parse(solverInput(job)), stock_length: job.settings.sheetLengthMm });
  return new Promise((resolveReport, reject) => {
    const report: Report = { constructors: 0, stages: [], logs: [] };
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      (async () => {
        let label = 'constructor';
        globalThis.postMessage = message => parentPort.postMessage({
          log: { stage: label, line: String(message.line ?? '') }
        });
        const wasm = await import(workerData.moduleUrl);
        wasm.initSync({ module: readFileSync(workerData.binary) });
        let session;
        try {
          const start = performance.now();
          session = new wasm.SheetSession(workerData.input, 1, 'fast');
          parentPort.postMessage({ constructed: true, wallMs: performance.now() - start });
          const run = (name, mode, budget, initial, retain) => {
            label = name;
            const request = { quantities: [10, 10], mode, budget_ms: budget,
              initial_snapshot: initial, retain_snapshot: retain };
            const events = [];
            const start = performance.now();
            session.step(JSON.stringify(request), workerData.seed, text => events.push({
              atMs: performance.now() - start, message: JSON.parse(text)
            }));
            parentPort.postMessage({ stage: { label, request, events, wallMs: performance.now() - start } });
            const feasible = events.map(event => event.message).filter(message => message.type === 'candidate');
            if (!feasible.length) throw Error('No candidate in ' + label);
            return feasible.reduce((a, b) => b.solution.strip_width < a.solution.strip_width ? b : a);
          };
          const cold = run('cold', 'search', 0);
          run('continuous', 'continuous', workerData.budgetMs, cold.snapshotId, cold.snapshotId);
          let previous = cold;
          for (let i = 0; i < workerData.slices; i++) {
            previous = run('compress-' + (i + 1), 'compress', workerData.budgetMs / workerData.slices,
              previous.snapshotId, cold.snapshotId);
          }
          parentPort.postMessage({ done: true });
        } catch (error) {
          parentPort.postMessage({ done: true, error: String(error) });
        } finally { session?.free(); }
      })().catch(error => { throw error; });
    `, {
      eval: true,
      workerData: {
        input, seed, budgetMs, slices,
        moduleUrl: pathToFileURL(resolve(root, 'web/wasm', pkg, 'sparrow_web.js')).href,
        binary: resolve(root, 'web/wasm', pkg, 'sparrow_web_bg.wasm'),
      },
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate().then(() => resolveReport(report), reject);
    };
    const timer = setTimeout(() => { report.timedOut = true; finish(); }, 30_000);
    worker.on('message', data => {
      if (finished) return;
      if (data.constructed) { report.constructors++; report.constructorMs = data.wallMs; }
      if (data.stage) report.stages.push(data.stage);
      if (data.log) report.logs.push(data.log);
      if (data.done) { report.error = data.error; finish(); }
    });
    worker.on('error', error => { clearTimeout(timer); void worker.terminate(); reject(error); });
    worker.on('exit', code => {
      if (!finished) { report.error = `Worker exited before completion (${code})`; finish(); }
    });
  });
}

it.each(['pkg', 'pkg-nosimd'])(
  'runs exploration and compression once without reconstructing compiled %s SheetSession',
  async pkg => {
    const job = fixture();
    const report = await isolated(pkg, job);
    const area = job.parts.reduce((sum, part) => sum + netArea(part) * part.quantity, 0);
    const summaries = report.stages.map(stage => ({
      stage: stage.label, budgetMs: stage.request.budget_ms, wallMs: stage.wallMs,
      phases: stage.events.flatMap(({ atMs, message }) => message.type === 'phase'
        ? [{ phase: message.phase, atMs }] : []),
      candidates: stage.events.flatMap(({ atMs, message }) => message.type === 'candidate' ? [{
        atMs, snapshotId: message.snapshotId, count: message.solution.layout.placed_items.length,
        usedLengthMm: message.solution.strip_width,
        utilization: area / (job.settings.materialWidthMm * message.solution.strip_width),
      }] : []),
      finalLengthMm: candidates(stage).at(-1)?.solution.strip_width,
      bestLengthMm: candidates(stage).length ? best(stage).solution.strip_width : undefined,
    }));
    const shortStages = report.stages.filter(stage => stage.request.mode === 'compress');
    console.log('continuous wasm comparison', JSON.stringify({
      pkg, seed, preset: 'fast', copies: 20, constructors: report.constructors,
      constructorMs: report.constructorMs, error: report.error, timedOut: report.timedOut,
      stages: summaries,
      comparison: {
        continuous: summaries.find(stage => stage.stage === 'continuous'),
        shortCompress: {
          steps: shortStages.length,
          totalBudgetMs: shortStages.reduce((sum, stage) => sum + stage.request.budget_ms, 0),
          wallMs: shortStages.reduce((sum, stage) => sum + stage.wallMs, 0),
          finalLengthMm: shortStages.length ? best(shortStages.at(-1)!).solution.strip_width : undefined,
          candidateCount: shortStages.reduce((sum, stage) => sum + candidates(stage).length, 0),
        },
      },
      simplificationLogs: report.logs.filter(log => log.line.includes('[PS]')),
      limitation: 'One serial worker per package, one seed, one run, continuous measured first. Equal requested cumulative budgets and the same retained internal cold snapshot do not imply equal work or wall time. Each short step resets its RNG and optimizer state. Budgets are cooperative; phase notifications prove entry, not useful work. Callback serialization is included, app validation is outside measured solver wall time. No speedup or quality superiority is asserted.',
    }, null, 2));
    expect(report.timedOut).not.toBe(true);
    expect(report.error).toBeUndefined();
    expect(report.constructors).toBe(1);
    expect(report.stages.map(stage => stage.label)).toEqual([
      'cold', 'continuous', 'compress-1', 'compress-2', 'compress-3', 'compress-4',
    ]);
    const [cold, continuous, shortFirst] = report.stages;
    expect(continuous.request.initial_snapshot).toBe(best(cold).snapshotId);
    expect(shortFirst.request.initial_snapshot).toBe(best(cold).snapshotId);
    for (const stage of [continuous, shortFirst]) {
      expect(candidates(stage)[0].solution).toEqual(best(cold).solution);
    }
    expect(continuous.events.flatMap(({ message }) => message.type === 'phase' ? [message.phase] : []))
      .toEqual(['Exploration', 'Compression']);
    expect(shortStages.reduce((sum, stage) => sum + stage.request.budget_ms, 0))
      .toBe(continuous.request.budget_ms);
    const ids: number[] = [];
    for (const stage of report.stages) {
      expect(stage.events.at(-1)?.message.type).toBe('finished');
      expect(candidates(stage).length).toBeGreaterThan(0);
      for (const candidate of candidates(stage)) {
        expect(validate(job, asResult(job, candidate))).toMatchObject({ status: 'passed', errors: [] });
        expect(candidate.solution.layout.placed_items).toHaveLength(20);
        expect(candidate.snapshotId).toBeGreaterThan(ids.at(-1) ?? 0);
        ids.push(candidate.snapshotId);
      }
    }
    const simplification = report.logs.filter(log => log.line.includes('[PS]'));
    expect(simplification.length).toBeGreaterThan(0);
    expect(simplification.every(log => log.stage === 'constructor')).toBe(true);
  },
  40_000,
);
