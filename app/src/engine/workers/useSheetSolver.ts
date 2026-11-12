import { useEffect, useRef, useState } from 'react';
import type { Job, Result } from '../model';
import { solveSheets, type SheetProgress } from '../sheets';
import { geometryTask } from './geometryTask';
import { sheetStripSolver } from './sheetSolver';
import type { Diagnostics, LiveFrame, RunState } from './useSolver';

export function useSheetSolver() {
  const [sheetHistory, setSheetHistory] = useState<
    {
      sheetIndex: number;
      insertionFailures: number;
      reason: NonNullable<SheetProgress['sheetEndReason']>;
    }[]
  >([]);
  const [phaseTrace, setPhaseTrace] = useState<
    { sheetIndex: number; phase: 'Insertion' | 'Compression'; insertionFailures: number }[]
  >([]);
  const lastPhaseTrace = useRef('');
  const [job, setJob] = useState<Job>();
  const [result, setResult] = useState<Result>();
  const [currentResult, setCurrentResult] = useState<Result>();
  const [sheetProgress, setSheetProgress] = useState<{
    roundIndex: number;
    sheetIndex: number;
    phase: 'Insertion' | 'Compression';
    insertionFailures: number;
<<<<<<< HEAD
    compressionStatus?: SheetProgress['compressionStatus'];
    sheetEndReason?: SheetProgress['sheetEndReason'];
=======
    selectedBoards?: number;
>>>>>>> dev
  }>();
  const [state, setState] = useState<RunState>('Ready');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const active = useRef<AbortController | undefined>(undefined);
  const diagnostics = useRef<Diagnostics | undefined>(undefined);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = undefined;
    },
    [],
  );
  useEffect(() => {
    if (state !== 'Running') return;
    const started = performance.now();
    const timer = setInterval(() => setElapsed((performance.now() - started) / 1000), 100);
    return () => clearInterval(timer);
  }, [state]);
  function invalidate() {
    active.current?.abort();
    active.current = undefined;
    setResult(undefined);
    setCurrentResult(undefined);
    setSheetProgress(undefined);
    setSheetHistory([]);
    setPhaseTrace([]);
    lastPhaseTrace.current = '';
    setState('Ready');
    setError('');
    setElapsed(0);
  }
  function start(doc: Job, revision: number, threads?: number) {
    invalidate();
    setJob(doc);
    setState('Running');
    const controller = new AbortController();
    active.current = controller;
    void solveSheets(doc, sheetStripSolver(revision, threads), {
      revision,
      signal: controller.signal,
      normalize: async (document, signal) => {
        const reply = await geometryTask(
          {
            type: 'normalize',
            runId: 1,
            documentRevision: revision,
            document,
          },
          signal,
        );
        if (reply.type !== 'normalized') throw Error('Unexpected normalization reply.');
        return reply.document;
      },
      validate: async (document, result, signal) => {
        const reply = await geometryTask(
          {
            type: 'validate',
            runId: 1,
            documentRevision: revision,
            document,
            result,
          },
          signal,
        );
        if (reply.type !== 'validated') throw Error('Unexpected validation reply.');
        return reply.validation;
      },
      onProgress: (progress) => {
<<<<<<< HEAD
        if (active.current !== controller || controller.signal.aborted) return;
        setSheetProgress({
          sheetIndex: progress.sheetIndex,
          phase: progress.phase,
          insertionFailures: progress.insertionFailures,
          compressionStatus: progress.compressionStatus,
          sheetEndReason: progress.sheetEndReason,
        });
        const traceKey = `${progress.sheetIndex}:${progress.phase}:${progress.insertionFailures}`;
        if (traceKey !== lastPhaseTrace.current) {
          lastPhaseTrace.current = traceKey;
          setPhaseTrace((trace) => [
            ...trace.slice(-19),
            {
              sheetIndex: progress.sheetIndex,
              phase: progress.phase,
              insertionFailures: progress.insertionFailures,
            },
          ]);
        }
        if (progress.sheetEndReason) {
          setSheetHistory((history) => [
            ...history,
            {
              sheetIndex: progress.sheetIndex,
              insertionFailures: progress.insertionFailures,
              reason: progress.sheetEndReason!,
            },
          ]);
        }
=======
        if (active.current === controller && !controller.signal.aborted)
          setSheetProgress({
            roundIndex: progress.roundIndex,
            sheetIndex: progress.sheetIndex,
            phase: progress.phase,
            insertionFailures: progress.insertionFailures,
            selectedBoards: progress.selectedBoards,
          });
>>>>>>> dev
      },
      onCurrentRound: (next) => {
        if (active.current === controller && !controller.signal.aborted) setCurrentResult(next);
      },
      onSheet: (next) => {
        if (active.current === controller) {
          setResult(next);
          setElapsed(next.elapsedSeconds);
        }
      },
    })
      .then((outcome) => {
        if (active.current !== controller) return;
        setResult(outcome.result);
        setElapsed(outcome.result.elapsedSeconds);
        setState(outcome.reason === 'Stopped' ? 'Stopped' : 'Complete');
        diagnostics.current = {
          runDocument: doc,
          solverRevision: outcome.result.solverRevision,
          seed: outcome.result.seed,
          buildMode: 'Virtual stitched board search',
          stopReason: outcome.reason,
          history: [],
          liveErrors: [],
        };
      })
      .catch((reason) => {
        if (active.current !== controller) return;
        setState(controller.signal.aborted ? 'Stopped' : 'Error');
        setError(String(reason));
      });
  }
  return {
    job,
    result,
    currentResult,
    sheetProgress,
    sheetHistory,
    phaseTrace,
    state,
    error,
    elapsed,
    diagnostics,
    live: undefined as LiveFrame | undefined,
    liveError: '',
    phase: undefined as string | undefined,
    workers: undefined as { actual: number; requested?: number; reason?: string } | undefined,
    canSkip: false,
    skipping: false,
    skipToCompression: () => {},
    start,
    stop: () => {
      active.current?.abort();
    },
    invalidate,
    load: (checked: Result) => {
      invalidate();
      setResult(checked);
      setCurrentResult(checked);
      setElapsed(checked.elapsedSeconds);
      setState('Complete');
    },
  };
}
