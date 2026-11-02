import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { projectJob, type ProjectDocument } from '../src/project/model';
import { solverInput } from '../src/engine/import/sparrow';

const root = resolve(import.meta.dirname, '../..');
const project = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/hazard-project.json'), 'utf8')) as ProjectDocument;
type Report = { seed: string; quantity: number; stages: unknown[]; logs: string[]; error?: string; timedOut?: boolean };

function isolated(seed: string, quantity: number): Promise<Report> {
  const job = projectJob(project);
  const input = JSON.stringify({ ...JSON.parse(solverInput(job)), stock_length: job.settings.sheetLengthMm });
  return new Promise(resolveReport => {
    const report: Report = { seed, quantity, stages: [], logs: [] };
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      let stage = 'constructor';
      const log = (...args) => parentPort.postMessage({ log: stage + ': ' + args.map(String).join(' ') });
      console.error = log;
      console.warn = log;
      console.log = log;
      globalThis.postMessage = message => log(message.line ?? JSON.stringify(message));
      (async () => {
        const wasm = await import(workerData.moduleUrl);
        wasm.initSync({ module: readFileSync(workerData.binary) });
        let session;
        try {
          session = new wasm.SheetSession(workerData.input, 0, 'standard');
          const run = (label, quantity, mode, budget, initial) => {
            stage = label;
            parentPort.postMessage({ entering: label });
            const start = performance.now();
            let best;
            const events = [];
            session.step(JSON.stringify({ quantities: [quantity], mode, budget_ms: budget,
              initial_snapshot: initial, retain_snapshot: initial }), workerData.seed, text => {
              const message = JSON.parse(text);
              if (message.type === 'candidate') {
                const candidate = { id: message.snapshotId, count: message.solution.layout.placed_items.length,
                  length: message.solution.strip_width };
                events.push(candidate);
                if (!best || candidate.length < best.length) best = candidate;
              } else if (message.type !== 'live') events.push(message);
            });
            parentPort.postMessage({ stage: { label, quantity, mode, budget, wallMs: performance.now()-start, events } });
            return best;
          };
          const cold = run('cold', workerData.quantity, 'search', 0);
          if (cold) {
            run('compress', workerData.quantity, 'compress', 4000, cold.id);
            if (workerData.quantity > 1) {
              const subset = run('subset', workerData.quantity - 1, 'search', 0);
              if (subset) run('subset-compress', workerData.quantity - 1, 'compress', 1000, subset.id);
            }
          }
          parentPort.postMessage({ done: true });
        } catch (error) { parentPort.postMessage({ done: true, error: stage + ': ' + String(error) }); }
        finally { session?.free(); }
      })().catch(error => parentPort.postMessage({ done: true, error: stage + ': ' + String(error) }));
    `, { eval: true, workerData: { seed, quantity, input,
      moduleUrl: pathToFileURL(resolve(root, 'web/wasm/pkg/sparrow_web.js')).href,
      binary: resolve(root, 'web/wasm/pkg/sparrow_web_bg.wasm') } });
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate().then(() => resolveReport(report));
    };
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { report.timedOut = true; finish(); }, 10_000);
    };
    resetTimer();
    worker.on('message', data => {
      if (done) return;
      if (data.entering) resetTimer();
      if (data.log) report.logs.push(data.log);
      if (data.stage) report.stages.push(data.stage);
      if (data.done) { report.error = data.error; finish(); }
    });
    worker.on('error', error => { report.error = String(error); finish(); });
    worker.on('exit', code => { if (!done) { report.error = `Worker exited (${code})`; finish(); } });
  });
}

it('replays current project geometry in bounded serial compiled WASM sessions', async () => {
  expect('solutions' in project).toBe(false);
  expect(project.parts[0].outer).toHaveLength(371);
  const started = performance.now();
  const reports: Report[] = [];
  for (const [seed, quantity] of [['42', 90], ['42', 40], ['4242', 40], ['1', 40]] as const) {
    if (performance.now() - started > 45_000) break;
    const report = await isolated(seed, quantity);
    reports.push(report);
    console.log('hazard reproduction', JSON.stringify({ ...report,
      logs: report.logs.filter(line => /panicked|HazardEntity|Stack:|remove_by_entity|wasm-function/.test(line)) }, null, 2));
    if (report.logs.some(line => line.includes('HazardEntity not found in collector'))) break;
  }
  expect(reports.length).toBeGreaterThan(0);
  for (const report of reports) {
    expect(report.timedOut, JSON.stringify(report)).not.toBe(true);
    if (report.quantity === 90) expect(report.error).toMatch(/^cold: Warm start insertion failed: could not construct an initial placement/);
    else expect(report.error, report.logs.join('\n')).toBeUndefined();
  }
}, 65_000);
