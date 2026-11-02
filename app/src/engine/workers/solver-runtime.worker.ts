import { loadSerialWasm, loadThreadedWasm, supportsSIMD, type SolverBinary } from '../wasm';
import type { Start, SessionInit, SessionStep, SessionCancel, SolverMessage } from './protocol';
import { normalizeJob } from '../geometry/normalize';
import { solverInput } from '../import/sparrow';

type Session = {
  step(request: string, seed: string, callback: (json: string) => void, interrupt?: () => boolean): void;
  free(): void;
};
type SessionWasm = typeof import('../../../../web/wasm/pkg/sparrow_web') & {
  SheetSession: new (input: string, clearance: number, preset: string) => Session;
};
let session: Session | undefined;
let sessionControl: Int32Array | undefined;
let activeAttempt: number | undefined;
let sessionIdentity: Pick<SessionInit, 'runId' | 'documentRevision'> | undefined;

self.onmessage = async ({ data }: MessageEvent<Start | SessionInit | SessionStep | SessionCancel | {type:'preload';threads:number}>) => {
  if (data.type === 'session-cancel') {
    if (activeAttempt === data.attemptId && sessionControl) Atomics.store(sessionControl, 0, 1);
    return;
  }
  if (data.type === 'session-step') {
    const send = (message: object) => self.postMessage({ ...message, runId: data.runId, documentRevision: data.documentRevision, attemptId: data.attemptId });
    try {
      if (!session || sessionIdentity?.runId !== data.runId || sessionIdentity.documentRevision !== data.documentRevision) throw Error('Sheet session is not initialized.');
      activeAttempt = data.attemptId;
      session.step(JSON.stringify({
        quantities: data.quantities, initial_snapshot: data.initialSnapshot,
        retain_snapshot: data.retainSnapshot, mode: data.mode, budget_ms: data.budgetMs,
      }), data.seed, (json: string) => {
        const message = JSON.parse(json) as SolverMessage;
        send(message.type === 'error' ? { ...message, type: 'attempt-error' } : message);
      }, sessionControl ? () => Atomics.load(sessionControl!, 0) === 1 : undefined);
    } catch (error) {
      send({ type: 'attempt-error', message: error instanceof Error ? (error.stack ?? String(error)) : String(error) });
    } finally {
      activeAttempt = undefined;
    }
    return;
  }
  if (data.type !== 'start' && data.type !== 'session-init' && data.type !== 'preload') return;
  const { runId, documentRevision } = data.type==='preload'?{runId:0,documentRevision:0}:data;
  const send = (message: object) => self.postMessage({ ...message, runId, documentRevision });
  try {
    let wasm: Pick<typeof import('../../../../web/wasm/pkg/sparrow_web'), 'run' | 'thread_count'>;
    if (data.threads && data.threads > 1) {
      const threaded = await loadThreadedWasm();
      await threaded.default();
      if(data.type!=='preload')await threaded.initThreadPool(data.threads);
      wasm = threaded;
    } else {
      const serial = await loadSerialWasm();
      await serial.default();
      wasm = serial;
    }
    // Download and compile off the UI thread; actual runs still own fresh workers.
    if(data.type==='preload'){self.postMessage({type:'preloaded'});self.close();return;}
    const solverBinary: SolverBinary = `${data.threads && data.threads > 1 ? 'threaded' : 'serial'}-${supportsSIMD ? 'simd' : 'nosimd'}`;
    send({ type: 'ready', threads: wasm.thread_count(), solverBinary, simd: supportsSIMD, canSkip: !!data.control });
    if (data.type === 'session-init') {
      const doc = normalizeJob(data.document);
      const catalog = { ...doc, parts: doc.parts.map(part => ({ ...part, quantity: Math.max(1, part.quantity) })) };
      const input = JSON.stringify({ ...JSON.parse(solverInput(catalog)), stock_length: doc.settings.sheetLengthMm });
      session?.free();
      sessionControl = data.control ? new Int32Array(data.control) : undefined;
      sessionIdentity = { runId, documentRevision };
      session = new (wasm as SessionWasm).SheetSession(input, doc.settings.clearanceMm, doc.settings.solverPreset);
      send({ type: 'session-ready' });
      return;
    }
    const doc=normalizeJob(data.document);
    const input=solverInput(doc, data.initialPlacement);
    const seconds=doc.settings.timeLimitSeconds,clearance=doc.settings.clearanceMm,preset=doc.settings.solverPreset;
    send({type:'run-input',input,seed:data.seed,seconds,clearance,preset,threads:wasm.thread_count(),solverBinary});
    const control=data.control?new Int32Array(data.control):undefined;
    wasm.run(input, seconds??undefined, data.seed, clearance, preset, (json: string) => {
      const message = JSON.parse(json) as SolverMessage;
      // Close the Skip gate synchronously, before the coordinator receives the phase change.
      if(control&&message.type==='phase'&&message.phase==='Compression')Atomics.store(control,0,-1);
      send(message);
    }, control?(reset:boolean)=>{if(reset)Atomics.compareExchange(control,0,1,0);return Atomics.load(control,0)===1;}:undefined);
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? (error.stack ?? String(error)) : String(error) });
    if(data.type==='preload')self.close();
  }
};
