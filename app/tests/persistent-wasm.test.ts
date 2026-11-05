import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { importDXF } from '../src/engine/import/dxf';
import { solverInput } from '../src/engine/import/sparrow';
import { validate } from '../src/engine/geometry/validate';
import { DEFAULT_SETTINGS, newPart, type Job, type Result } from '../src/engine/model';
import { normalizeSheetStock } from '../src/engine/stock';

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
type Message = { type: string };
type Request = {
  quantities: number[];
  mode: 'search' | 'compress';
  budget_ms: number;
  initial_snapshot?: number;
  initial_placement?: { used_length_mm: number; placements: { item_id: number; rotation: number; translation: [number, number] }[] };
  retain_snapshot?: number;
};
type Session = { step(request: string, seed: string, callback: (text: string) => void): void };
const root = resolve(import.meta.dirname, '../..');
const wasmPath = (pkg: string, file: string) => resolve(root, 'web/wasm', pkg, file);
const candidates = (messages: Message[]) => messages.filter((m): m is Candidate => m.type === 'candidate');
const best = (messages: Message[]) => candidates(messages).reduce((a, b) =>
  b.solution.strip_width < a.solution.strip_width ? b : a,
);
function step(session: Session, request: Request): Message[] {
  const messages: Message[] = [];
  session.step(JSON.stringify(request), '42', (text) => messages.push(JSON.parse(text)));
  expect(messages.at(-1)?.type).toBe('finished');
  expect(candidates(messages).length).toBeGreaterThan(0);
  return messages;
}
function asResult(job: Job, candidate: Candidate): Result {
  const copies = new Map<number, number>();
  return {
    documentRevision: 0, solverRevision: 'persistent-wasm-regression', seed: '42',
    elapsedSeconds: 0, usedLengthMm: candidate.solution.strip_width,
    placements: candidate.solution.layout.placed_items.map((item) => {
      const copyIndex = copies.get(item.item_id) ?? 0;
      copies.set(item.item_id, copyIndex + 1);
      return {
        partId: job.parts[item.item_id].id, copyIndex,
        angleDeg: item.transformation.rotation,
        xMm: item.transformation.translation[0], yMm: item.transformation.translation[1],
      };
    }),
    validation: { status: 'pending', overlapAreaMm2: 0, maxBoundaryViolationMm: 0, minClearanceMm: null, errors: [] },
  };
}
function check(job: Job, quantities: number[], messages: Message[]) {
  const requested = { ...job, parts: job.parts.map((part, i) => ({ ...part, quantity: quantities[i] })) };
  for (const candidate of candidates(messages)) {
    expect(validate(requested, asResult(requested, candidate))).toMatchObject({ status: 'passed', errors: [] });
    const placed = candidate.solution.layout.placed_items;
    expect(quantities.map((_, i) => placed.filter((item) => item.item_id === i).length)).toEqual(quantities);
  }
}

afterEach(() => vi.unstubAllGlobals());

it.each(['pkg', 'pkg-nosimd'])('preserves catalog IDs, snapshots and retained fallback in compiled %s', async (pkg) => {
  vi.stubGlobal('postMessage', () => {});
  const wasm = await import(`../../web/wasm/${pkg}/sparrow_web.js`);
  wasm.initSync({ module: readFileSync(wasmPath(pkg, 'sparrow_web_bg.wasm')) });
  const stock = normalizeSheetStock({
    id: 'fixture-stock', name: 'stock with hole', kind: 'polygon', quantity: 1, priority: 0,
    lengthMm: 120, widthMm: 50, outer: [[0, 0], [120, 0], [120, 50], [0, 50]],
    holes: [[[100, 30], [110, 30], [110, 40], [100, 40]]],
  });
  const job: Job = {
    name: 'persistent two-type catalog',
    parts: [20, 12].map((size, i) => ({
      ...newPart([[0, 0], [size, 0], [size, size], [0, size]]),
      id: `stable-part-${i}`, quantity: i === 0 ? 2 : 1,
      rotations: { kind: 'discrete', degrees: [0] },
    })),
    settings: { ...DEFAULT_SETTINGS, solverPreset: 'fast', materialWidthMm: 50, sheetLengthMm: 120, sheetStock: stock, clearanceMm: 1 },
  };
  const session = new wasm.SheetSession(solverInput(job), 1, 'fast');
  const published: number[] = [];
  const run = (request: Request) => {
    const messages = step(session, request);
    check(job, request.quantities, messages);
    for (const candidate of candidates(messages)) {
      expect(candidate.snapshotId).toBeGreaterThan(published.at(-1) ?? 0);
      published.push(candidate.snapshotId);
    }
    return messages;
  };
  try {
    const cold = best(run({ quantities: [1, 0], mode: 'search', budget_ms: 0 }));
    expect(cold.solution.layout.placed_items[0].item_id).toBe(0);
    const compressedMessages = run({ quantities: [1, 0], initial_snapshot: cold.snapshotId, retain_snapshot: cold.snapshotId, mode: 'compress', budget_ms: 20 });
    for (const candidate of candidates(compressedMessages))
      expect(candidate.solution.strip_width).toBeLessThanOrEqual(cold.solution.strip_width);
    const compressed = best(compressedMessages);
    // Resume from the older accepted geometry, not necessarily the newest published ID.
    const resumed = run({ quantities: [1, 0], initial_snapshot: cold.snapshotId,
      retain_snapshot: compressed.snapshotId, mode: 'compress', budget_ms: 20 });
    expect(resumed.filter(message => (message as { phase?: string }).phase === 'Compression')).toHaveLength(1);
    expect(candidates(resumed).filter(message => (message as Candidate & { report?: string }).report === 'ExplFeas')).toHaveLength(1);
    const zero = run({ quantities: [1, 0], initial_snapshot: compressed.snapshotId,
      retain_snapshot: compressed.snapshotId, mode: 'compress', budget_ms: 0 });
    expect(candidates(zero)).toHaveLength(1);
    const inserted = best(run({ quantities: [2, 1], initial_snapshot: compressed.snapshotId, retain_snapshot: compressed.snapshotId, mode: 'search', budget_ms: 0 }));
    for (const item of compressed.solution.layout.placed_items)
      expect(inserted.solution.layout.placed_items).toContainEqual(item);
    expect(() => step(session, { quantities: [499, 1], initial_snapshot: inserted.snapshotId, retain_snapshot: compressed.snapshotId, mode: 'search', budget_ms: 0 })).toThrow(/Warm start insertion failed:/);
    expect(() => step(session, { quantities: [0, 1], initial_snapshot: inserted.snapshotId, retain_snapshot: compressed.snapshotId, mode: 'search', budget_ms: 0 })).toThrow(/below existing placement/);
    const restored = best(run({ quantities: [1, 0], initial_snapshot: compressed.snapshotId, retain_snapshot: compressed.snapshotId, mode: 'search', budget_ms: 0 }));
    expect(restored.solution.layout).toEqual(compressed.solution.layout);
    // A cold retry drops initial_snapshot, not the catalog or the retained solution.
    const fallback = best(run({ quantities: [0, 1], retain_snapshot: restored.snapshotId, mode: 'search', budget_ms: 0 }));
    expect(fallback.solution.layout.placed_items[0].item_id).toBe(1);
    run({ quantities: [1, 0], initial_snapshot: restored.snapshotId, retain_snapshot: restored.snapshotId, mode: 'search', budget_ms: 0 });
    expect(() => step(session, { quantities: [1, 0], initial_snapshot: cold.snapshotId, retain_snapshot: restored.snapshotId, mode: 'search', budget_ms: 0 })).toThrow(/expired/);
    run({ quantities: [1, 0], initial_snapshot: restored.snapshotId, mode: 'search', budget_ms: 0 });
    const external = (candidate: Candidate) => ({
      used_length_mm: candidate.solution.strip_width,
      placements: candidate.solution.layout.placed_items.map(item => ({ item_id: item.item_id,
        rotation: item.transformation.rotation, translation: item.transformation.translation })),
    });
    const restarted = new wasm.SheetSession(solverInput(job), 1, 'fast');
    try {
      const appended = best(step(restarted, { quantities: [2, 1], initial_placement: external(compressed), mode: 'search', budget_ms: 0 }));
      check(job, [2, 1], [appended]);
      for (const item of compressed.solution.layout.placed_items)
        expect(appended.solution.layout.placed_items).toContainEqual(item);
      const subset = external(appended);
      subset.placements.splice(subset.placements.findIndex(item => item.item_id === 0), 1);
      const deleted = best(step(restarted, { quantities: [1, 1], initial_placement: subset, mode: 'search', budget_ms: 0 }));
      check(job, [1, 1], [deleted]);
      expect(external(deleted).placements).toEqual(subset.placements);
      expect(() => step(restarted, { quantities: [0, 1], initial_placement: {
        ...subset, placements: [{ item_id: 1, rotation: 0, translation: [-100, -100] }],
      }, mode: 'search', budget_ms: 0 })).toThrow(/Initial placement/);
    } finally {
      restarted.free();
    }
  } finally {
    session.free();
  }
}, 15000);

type Stage = { stage: string; wallMs: number; messages: Message[]; request?: Request };
type CircleReport = { stages: Stage[]; logs: { stage: string; line: string }[]; constructors: number; error?: string; timedOut?: boolean };

function circleIsolated(pkg: string, input: string, clearance: number): Promise<CircleReport> {
  return new Promise((resolveReport, reject) => {
    const report: CircleReport = { stages: [], logs: [], constructors: 0 };
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      (async () => {
        const wasm = await import(workerData.moduleUrl);
        let stage = 'constructor';
        globalThis.postMessage = message => parentPort.postMessage({ log: { stage, line: String(message.line ?? '') } });
        wasm.initSync({ module: readFileSync(workerData.binary) });
        let session;
        try {
          let start = performance.now();
          session = new wasm.SheetSession(workerData.input, workerData.clearance, 'fast');
          parentPort.postMessage({ constructor: true, result: { stage, wallMs: performance.now() - start, messages: [] } });
          let snapshot;
          for (const [label, quantity, mode, budget] of [
            ['cold-24', 24, 'search', 0], ['compress-24', 24, 'compress', 100],
            ['insert-25', 25, 'search', 0], ['insert-26', 26, 'search', 0],
          ]) {
            stage = label;
            const request = { quantities: [quantity], mode, budget_ms: budget,
              initial_snapshot: snapshot, retain_snapshot: snapshot };
            const messages = [];
            start = performance.now();
            session.step(JSON.stringify(request), '42', text => messages.push(JSON.parse(text)));
            parentPort.postMessage({ result: { stage, request, wallMs: performance.now() - start, messages } });
            const feasible = messages.filter(m => m.type === 'candidate');
            if (!feasible.length) throw Error('No candidates in ' + stage);
            snapshot = feasible.reduce((a, b) => b.solution.strip_width < a.solution.strip_width ? b : a).snapshotId;
          }
          parentPort.postMessage({ done: true });
        } catch (error) { parentPort.postMessage({ done: true, error: String(error) }); }
        finally { session?.free(); }
      })().catch(error => { throw error; });
    `, { eval: true, workerData: {
      input, clearance,
      moduleUrl: pathToFileURL(wasmPath(pkg, 'sparrow_web.js')).href,
      binary: wasmPath(pkg, 'sparrow_web_bg.wasm'),
    } });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate().then(() => resolveReport(report), reject);
    };
    const timer = setTimeout(() => { report.timedOut = true; finish(); }, 120000);
    worker.on('message', data => {
      if (finished) return;
      if (data.log) report.logs.push(data.log);
      if (data.constructor === true) report.constructors++;
      if (data.result) report.stages.push(data.result);
      if (data.done) { report.error = data.error; finish(); }
    });
    worker.on('error', error => { clearTimeout(timer); void worker.terminate(); reject(error); });
    worker.on('exit', code => {
      if (!finished) { report.error = `Worker exited before completion (${code})`; finish(); }
    });
  });
}

it.each(['pkg', 'pkg-nosimd'])('constructs circle catalog60 once, compresses and inserts 24/25/26 in compiled %s', async (pkg) => {
  const options = { scale: 1, tolerance: 0.01, enclosed: 'holes' as const };
  const sheet = importDXF(readFileSync(resolve(root, 'test/circle sheet.dxf'), 'utf8'), 'circle sheet.dxf', options);
  const parts = importDXF(readFileSync(resolve(root, 'test/_6.dxf'), 'utf8'), '_6.dxf', options);
  expect(sheet.issues).toEqual([]);
  expect(parts.issues).toEqual([]);
  expect(parts.document.parts).toHaveLength(1);
  const contour = sheet.document.parts[0];
  const stock = normalizeSheetStock({
    id: 'circle', name: 'circle sheet', kind: 'polygon', outer: contour.outer, holes: contour.holes,
    widthMm: 1, lengthMm: 1, quantity: 1, priority: 0,
  });
  const job: Job = {
    name: 'persistent circle catalog60', parts: parts.document.parts.map(part => ({ ...part, quantity: 60 })),
    settings: { ...parts.document.settings, materialWidthMm: stock.widthMm, sheetLengthMm: stock.lengthMm, sheetStock: stock, solverPreset: 'fast' },
  };
  const report = await circleIsolated(pkg, solverInput(job), job.settings.clearanceMm);
  console.log('persistent circle timings', JSON.stringify({
    pkg, catalogDemand: 60, constructors: report.constructors, timedOut: report.timedOut, error: report.error,
    stages: report.stages.map(stage => ({
      stage: stage.stage, wallMs: stage.wallMs, budgetMs: stage.request?.budget_ms,
      candidates: candidates(stage.messages).map(candidate => ({ snapshotId: candidate.snapshotId,
        count: candidate.solution.layout.placed_items.length, usedLengthMm: candidate.solution.strip_width })),
    })),
    simplificationLogs: report.logs.filter(log => log.line.includes('[PS]')),
    limitation: '100ms is a cooperative optimization budget, not a hard wall-clock limit; no guaranteed compression improvement or statistically controlled cold-rebuild benchmark.',
  }, null, 2));
  expect(report.timedOut).not.toBe(true);
  expect(report.error).toBeUndefined();
  expect(report.constructors).toBe(1);
  expect(report.stages.map(stage => stage.stage)).toEqual(['constructor', 'cold-24', 'compress-24', 'insert-25', 'insert-26']);
  const simplify = report.logs.filter(log => log.line.includes('[PS]'));
  expect(simplify.length).toBeGreaterThan(0);
  expect(simplify.every(log => log.stage === 'constructor')).toBe(true);
  const ids: number[] = [];
  for (const stage of report.stages.slice(1)) {
    expect(stage.messages.at(-1)?.type).toBe('finished');
    expect(candidates(stage.messages).length).toBeGreaterThan(0);
    check(job, stage.request!.quantities, stage.messages);
    for (const candidate of candidates(stage.messages)) {
      expect(candidate.snapshotId).toBeGreaterThan(ids.at(-1) ?? 0);
      ids.push(candidate.snapshotId);
    }
  }
  const [cold, compression, insert25, insert26] = report.stages.slice(1);
  for (const candidate of candidates(compression.messages))
    expect(candidate.solution.strip_width).toBeLessThanOrEqual(best(cold.messages).solution.strip_width);
  for (const [before, after] of [[compression, insert25], [insert25, insert26]])
    for (const item of best(before.messages).solution.layout.placed_items)
      expect(best(after.messages).solution.layout.placed_items).toContainEqual(item);
}, 140000);
