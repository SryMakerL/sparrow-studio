import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { importDXF } from '../src/engine/import/dxf';
import { solverInput } from '../src/engine/import/sparrow';
import { normalizeSheetStock } from '../src/engine/stock';
import type { Job, Result } from '../src/engine/model';
import { solveSheets } from '../src/engine/sheets';
import { validate } from '../src/engine/geometry/validate';

type Solution = {
  strip_width: number;
  layout: {
    placed_items: {
      item_id: number;
      transformation: { rotation: number; translation: [number, number] };
    }[];
  };
};
type RunReport = {
  label: string;
  durationMs: number;
  candidateMs: number[];
  candidates: Solution[];
  events: { atMs: number; message: Record<string, unknown> }[];
  error?: string;
  timedOut?: boolean;
};

// A synchronous wasm constructor cannot be stopped by Vitest's own test timeout.
function runIsolated(
  label: string,
  input: string,
  options: {
    signal?: AbortSignal;
    budgetMs?: number;
    onCandidate?: (solution: Solution, atMs: number, report: string) => void;
  } = {},
): Promise<RunReport> {
  return new Promise((resolveReport, reject) => {
    const report: RunReport = { label, durationMs: 0, candidateMs: [], candidates: [], events: [] };
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      (async () => {
        const wasm = await import(workerData.moduleUrl);
        let start;
        const send = message => parentPort.postMessage({ atMs: performance.now() - start, message });
        globalThis.postMessage = send;
        wasm.initSync({ module: readFileSync(workerData.binary) });
        start = performance.now();
        parentPort.postMessage({ started: true });
        try {
          wasm.run(workerData.input, 10, '42', 0, 'fast', text => send(JSON.parse(text)), () => true);
          parentPort.postMessage({ done: true, durationMs: performance.now() - start });
        } catch (error) {
          parentPort.postMessage({ done: true, durationMs: performance.now() - start, error: String(error) });
        }
      })().catch(error => { throw error; });
    `,
      {
        eval: true,
        workerData: {
          input,
          moduleUrl: pathToFileURL(resolve('../web/wasm/pkg/sparrow_web.js')).href,
          binary: resolve('../web/wasm/pkg/sparrow_web_bg.wasm'),
        },
      },
    );
    const started = performance.now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (!report.durationMs) report.durationMs = performance.now() - started;
      void worker.terminate().then(() => resolveReport(report));
    };
    const abort = () => finish();
    const timer = setTimeout(() => {
      report.timedOut = true;
      finish();
    }, options.budgetMs ?? 120000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) finish();
    worker.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    worker.on('message', (data) => {
      if (done || data.started) return;
      if (data.done) {
        report.durationMs = data.durationMs;
        report.error = data.error;
        finish();
        return;
      }
      report.events.push(data);
      if (data.message.type === 'candidate') {
        report.candidateMs.push(data.atMs);
        report.candidates.push(data.message.solution);
        options.onCandidate?.(data.message.solution, data.atMs, data.message.report);
      }
    });
  });
}

function asResult(job: Job, solution: Solution): Result {
  return {
    documentRevision: 0,
    solverRevision: 'compiled-circle-insertion-regression',
    seed: '42',
    elapsedSeconds: 0,
    usedLengthMm: solution.strip_width,
    placements: solution.layout.placed_items.map((item, copyIndex) => ({
      partId: job.parts[item.item_id].id,
      copyIndex,
      angleDeg: item.transformation.rotation,
      xMm: item.transformation.translation[0],
      yMm: item.transformation.translation[1],
    })),
    validation: {
      status: 'pending',
      overlapAreaMm2: 0,
      maxBoundaryViolationMm: 0,
      minClearanceMm: null,
      errors: [],
    },
  };
}

function printReport(report: RunReport) {
  console.log(
    JSON.stringify(
      {
        ...report,
        candidates: report.candidates.map((solution) => ({
          usedLengthMm: solution.strip_width,
          placed: solution.layout.placed_items.length,
        })),
        events: report.events.map((event) => ({
          atMs: event.atMs,
          ...event.message,
          ...(event.message.solution ? { solution: '(summarized above)' } : {}),
        })),
      },
      null,
      2,
    ),
  );
}

it('replays circle DXF construction and insertion using the actual compiled wasm', async () => {
  const options = { scale: 1, tolerance: 0.01, enclosed: 'holes' as const };
  const sheet = importDXF(
    readFileSync('../test/circle sheet.dxf', 'utf8'),
    'circle sheet.dxf',
    options,
  );
  const parts = importDXF(readFileSync('../test/_6.dxf', 'utf8'), '_6.dxf', options);
  expect(sheet.issues).toEqual([]);
  expect(parts.issues).toEqual([]);
  expect(parts.document.parts).toHaveLength(1);
  const contour = sheet.document.parts[0];
  const stock = normalizeSheetStock({
    id: 'circle',
    name: 'circle sheet',
    kind: 'polygon',
    outer: contour.outer,
    holes: contour.holes,
    widthMm: 1,
    lengthMm: 1,
    quantity: 1,
    priority: 0,
  });
  const job: Job = {
    name: 'circle _6 insertion',
    parts: parts.document.parts.map((part) => ({ ...part, quantity: 24 })),
    settings: {
      ...parts.document.settings,
      materialWidthMm: stock.widthMm,
      sheetLengthMm: stock.lengthMm,
      sheetStock: stock,
      solverPreset: 'fast',
      timeLimitSeconds: 10,
    },
  };
  console.log(
    'circle fixture',
    JSON.stringify({
      requestedByUser: 60,
      coldDemand: 24,
      stockLength: stock.lengthMm,
      stockWidth: stock.widthMm,
      sheetVertices: stock.outer.length,
      partVertices: job.parts.map((part) => part.outer.length),
      warnings: [...sheet.warnings, ...parts.warnings],
    }),
  );
  const coldInput = solverInput(job);
  expect(JSON.parse(coldInput).stock_length).toBeUndefined();
  const cold = await runIsolated('cold-24', coldInput);
  printReport(cold);
  expect(cold.timedOut).not.toBe(true);
  expect(cold.error).toBeUndefined();
  expect(cold.candidates.length).toBeGreaterThan(0);
  expect(cold.candidates[0].layout.placed_items).toHaveLength(24);
  const initial = asResult(job, cold.candidates[0]);
  for (const demand of [25, 26]) {
    const warmJob = { ...job, parts: job.parts.map((part) => ({ ...part, quantity: demand })) };
    const input = solverInput(warmJob, initial);
    const parsed = JSON.parse(input);
    expect(parsed.initial_placement.placements).toHaveLength(24);
    expect(parsed.stock_length).toBe(stock.lengthMm);
    console.log(
      'warm input',
      JSON.stringify({
        demand,
        oldUsedLength: initial.usedLengthMm,
        stockLength: parsed.stock_length,
        oldPlacements: parsed.initial_placement.placements.length,
      }),
    );
    const warm = await runIsolated(`warm-24-to-${demand}`, input);
    printReport(warm);
    expect(warm.timedOut).not.toBe(true);
    expect(warm.error).toBeUndefined();
    expect(warm.candidates.length).toBeGreaterThan(0);
    expect(
      warm.candidates.every((candidate) => candidate.layout.placed_items.length === demand),
    ).toBe(true);
    expect(
      warm.events.some((event) =>
        String(event.message.line).includes('warm starting from provided initial solution'),
      ),
    ).toBe(true);
  }
}, 370000);

it('coordinates sixty actual DXF parts through solveSheets and validates wasm candidates', async () => {
  const options = { scale: 1, tolerance: 0.01, enclosed: 'holes' as const };
  const sheet = importDXF(
    readFileSync('../test/circle sheet.dxf', 'utf8'),
    'circle sheet.dxf',
    options,
  );
  const parts = importDXF(readFileSync('../test/_6.dxf', 'utf8'), '_6.dxf', options);
  expect(sheet.issues).toEqual([]);
  expect(parts.issues).toEqual([]);
  const contour = sheet.document.parts[0];
  const stock = normalizeSheetStock({
    id: 'circle',
    name: 'circle sheet',
    kind: 'polygon',
    outer: contour.outer,
    holes: contour.holes,
    widthMm: 1,
    lengthMm: 1,
    quantity: 1,
    priority: 0,
  });
  const job: Job = {
    name: 'circle _6 sixty coordinated',
    parts: parts.document.parts.map((part) => ({ ...part, quantity: 60 })),
    settings: {
      ...parts.document.settings,
      materialWidthMm: stock.widthMm,
      sheetLengthMm: stock.lengthMm,
      sheetStock: stock,
      sheetStocks: [stock],
      sheetCount: 1,
      sheetStagnationSeconds: 60,
      solverPreset: 'fast',
      timeLimitSeconds: 60,
    },
  };
  const controller = new AbortController();
  const started = performance.now();
  const attempts: Record<string, unknown>[] = [];
  let firstValidationFailure: unknown;
  let maximumValidated = 0;
  let maximumPublished = 0;
  const outcome = await solveSheets(
    job,
    async (child, signal, onCandidate, budgetMs, initialPlacement) => {
      const demand = child.parts.reduce((sum, part) => sum + part.quantity, 0);
      const entry: Record<string, unknown> = {
        demand,
        initialCount: initialPlacement?.placements.length ?? 0,
        initialLength: initialPlacement?.usedLengthMm,
        budgetMs,
        atMs: performance.now() - started,
      };
      attempts.push(entry);
      console.log('coordinated attempt', JSON.stringify(entry));
      let best: Result | undefined;
      const report = await runIsolated(
        `coordinated-${attempts.length}-${demand}`,
        solverInput(child, initialPlacement),
        {
          signal,
          budgetMs,
          onCandidate: (solution, atMs, candidateReport) => {
            const result = asResult(child, solution);
            const validation = validate(child, result);
            result.validation = validation;
            if (validation.status === 'passed')
              maximumValidated = Math.max(maximumValidated, result.placements.length);
            else firstValidationFailure ??= { demand, candidateReport, atMs, validation };
            console.log(
              'coordinated candidate',
              JSON.stringify({
                demand,
                initialCount: initialPlacement?.placements.length ?? 0,
                report: candidateReport,
                atMs,
                usedLengthMm: result.usedLengthMm,
                placed: result.placements.length,
                validation,
              }),
            );
            if (!best || result.usedLengthMm < best.usedLengthMm) best = result;
            onCandidate?.(result);
          },
        },
      );
      Object.assign(entry, {
        durationMs: report.durationMs,
        candidateMs: report.candidateMs,
        error: report.error,
        timedOut: report.timedOut,
        logs: report.events
          .filter((event) => event.message.type === 'solver-log')
          .map((event) => event.message.line),
      });
      console.log('coordinated attempt finished', JSON.stringify(entry));
      if (
        report.error &&
        !/^(Warm start insertion failed:|Invalid initial placement|Initial placement|No valid initial placement)/.test(
          report.error,
        )
      ) {
        throw Error(report.error);
      }
      return report.error ? undefined : best;
    },
    {
      signal: controller.signal,
      validate: async (child, result) => validate(child, result),
      onSheet: (result) => {
        const count =
          result.sheets?.reduce((sum, sheet) => sum + sheet.result.placements.length, 0) ?? 0;
        maximumPublished = Math.max(maximumPublished, count);
        console.log(
          'coordinated published',
          JSON.stringify({
            count,
            unplaced: result.unplaced,
            atMs: performance.now() - started,
            validation: result.validation,
          }),
        );
        if (count > 24) controller.abort();
      },
    },
  );
  console.log(
    'coordinated summary',
    JSON.stringify(
      {
        reason: outcome.reason,
        durationMs: performance.now() - started,
        maximumValidated,
        maximumPublished,
        firstValidationFailure: firstValidationFailure ?? null,
        attempts,
        finalUnplaced: outcome.result.unplaced,
        limitation:
          'fast construction only; cold24 length 732.29 is not screenshot compressed length 436',
      },
      null,
      2,
    ),
  );
  expect(maximumValidated).toBeGreaterThan(24);
  expect(maximumPublished).toBeGreaterThan(24);
  expect(validate(job, outcome.result).status).toBe('passed');
}, 90000);
