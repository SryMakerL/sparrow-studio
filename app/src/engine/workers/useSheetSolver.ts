import { useEffect, useRef, useState } from 'react';
import type { Job, Result } from '../model';
import { solveSheets } from '../sheets';
import { geometryTask } from './geometryTask';
import { sheetStripSolver } from './sheetSolver';
import type { Diagnostics, LiveFrame, RunState } from './useSolver';

export function useSheetSolver() {
  const [job, setJob] = useState<Job>();
  const [result, setResult] = useState<Result>();
  const [currentResult, setCurrentResult] = useState<Result>();
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
    const run = {
      ...doc,
      settings: { ...doc.settings, solverThreads: threads ?? doc.settings.solverThreads ?? 0 },
    };
    void solveSheets(run, sheetStripSolver(revision, run.settings.solverThreads), {
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
        setCurrentResult(outcome.result);
        setElapsed(outcome.result.elapsedSeconds);
        setState(outcome.reason === 'Stopped' ? 'Stopped' : 'Complete');
        diagnostics.current = {
          runDocument: doc,
          solverRevision: outcome.result.solverRevision,
          seed: outcome.result.seed,
          buildMode: 'Bounded sheet strip jobs',
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
