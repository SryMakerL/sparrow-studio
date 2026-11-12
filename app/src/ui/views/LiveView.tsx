import { useMemo, useRef, useState } from 'react';
import { netArea, worldParts } from '../../engine/geometry/validate';
import type { Job } from '../../engine/model';
import type { DisplayUnit } from '../../engine/units';
import type { Timing } from '../../engine/workers/useSolver';
import { activeMachine, copyCount, usedUtilization } from '../../project/model';
import { Canvas } from '../Canvas';
import { useStudio } from '../context';
import { formatLength, formatPercent, formatSeconds } from '../format';
import { RunBar } from '../RunBar';
import { rulerStep } from '../rulers';
import { sheetStack } from './sheetStack';
import { LayoutDrawing } from './LayoutDrawing';

export function LiveView() {
  const { solver, runJob, unit, running, project, setTab } = useStudio();
  const [mode, setMode] = useState<'live' | 'best'>('live');
  const batch = !!runJob?.settings.sheetCount;
  const currentResult = batch ? solver.currentResult : solver.result;
  const completed = currentResult?.sheets;
  const lastSheet = completed?.at(-1);
  const best = batch ? lastSheet?.result : solver.result;
  const displayJob = batch ? lastSheet?.job : runJob;
  const frame = batch ? undefined : solver.live;
  const showLive = mode === 'live' && !!frame;
  const bestWorld = useMemo(
    () => (displayJob && best ? worldParts(displayJob, best) : []),
    [displayJob, best],
  );
  const history = (solver.diagnostics.current?.history ?? []).filter(
    (entry) => entry.validation === 'passed',
  );
  const width = runJob?.settings.materialWidthMm ?? project.stock.strip.widthMm;
  const shownLength =
    runJob?.settings.sheetLengthMm ??
    (showLive ? frame?.result.usedLengthMm : best?.usedLengthMm) ??
    width * 2;
  // Keep the view still while the layout shrinks: fit to the longest layout of this run.
  const longest = useRef({ job: runJob, length: 0 });
  if (longest.current.job !== runJob) longest.current = { job: runJob, length: 0 };
  longest.current.length = Math.max(longest.current.length, shownLength);

  const sheetWorlds = useMemo(
    () => completed?.map((sheet) => worldParts(sheet.job, sheet.result)) ?? [],
    [completed],
  );
  const stack = sheetStack(completed ?? [], width, shownLength);
  const limit = runJob?.settings.timeLimitSeconds ?? null;
  const status =
    solver.state === 'Initializing'
      ? 'Starting the solver…'
      : solver.state === 'Running'
        ? 'Searching'
        : solver.state === 'Complete'
          ? 'Finished'
          : solver.state === 'Stopped'
            ? 'Stopped'
            : solver.state === 'Error'
              ? 'The run failed'
              : 'Ready';

  return (
    <div className="view">
      <section className="list-panel" aria-label="Run progress">
        <div className="list-head">
          <span className="label">{runJob ? status : 'Next run'}</span>
          {running && <span className="muted">in this browser</span>}
        </div>
        <div className="list-scroll">
          {!runJob ? (
            <NextRun onSolution={project.solutions.length ? () => setTab('solution') : undefined} />
          ) : (
            <div className="summary">
              <div className="metrics">
                <div className="metric">
                  <span className="metric-value">
                    {best && displayJob
                      ? formatPercent(usedUtilization(displayJob, best, netArea))
                      : '—'}
                  </span>
                  <span className="muted">
                    {batch ? 'last sheet used-area utilization' : 'utilization'}
                  </span>
                </div>
                <div className="metric">
                  <span className="metric-value">
                    {best ? formatLength(best.usedLengthMm, unit) : '—'} <small>{unit}</small>
                  </span>
                  <span className="muted">length used</span>
                </div>
              </div>
              <span className="muted">
                {batch
                  ? `${completed?.length ?? 0} boards in the validated candidate layout · ${currentResult?.unplaced?.reduce((sum, part) => sum + part.quantity, 0) ?? copyCount(runJob?.parts ?? [])} parts unplaced.`
                  : 'Of the best valid layout so far.'}
              </span>
              {batch && running && solver.sheetProgress && (
                <dl className="facts">
                  <dt>Boards in current combination</dt>
                  <dd>{solver.sheetProgress.selectedBoards ?? '—'}</dd>
                  <dt>Current stage</dt>
                  <dd>
                    {solver.sheetProgress.phase === 'Insertion'
                      ? 'Joint search'
                      : 'Joint compression'}
                  </dd>
                  <dt>Candidate combination round</dt>
                  <dd>{solver.sheetProgress.roundIndex + 1}</dd>
                </dl>
              )}
              <div className="stack">
                <span className="muted">
                  {formatSeconds(solver.elapsed)}
                  {limit
                    ? ` of ${formatSeconds(limit)}${batch ? ' total search time' : ''}`
                    : batch
                      ? ' · no total deadline; press Stop to finish'
                      : ' · stops when the search stalls'}
                </span>
                {limit && (
                  <div className="progress" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, (solver.elapsed / limit) * 100)}%` }} />
                  </div>
                )}
              </div>
              {!batch && history.length > 1 && (
                <ImprovementChart history={history} job={runJob} elapsed={solver.elapsed} />
              )}
              {solver.error && <p className="field-error">{solver.error}</p>}
              {!running && solver.result && (
                <button className="primary" onClick={() => setTab('solution')}>
                  Show the solution
                </button>
              )}
              {running && solver.canSkip && solver.phase === 'Exploration' && (
                <button
                  className="small"
                  disabled={!best || solver.skipping}
                  onClick={solver.skipToCompression}
                >
                  Skip to compression
                </button>
              )}
              <p className="muted">
                {batch ? 'Joint virtual-board solver · ' : solver.phase ? `${solver.phase} · ` : ''}
                {solver.workers
                  ? `${solver.workers.actual} solver threads`
                  : batch
                    ? 'Local sheet solver'
                    : 'Preparing threads'}
                {running ? ' · keep this tab visible for the best speed.' : ''}
              </p>
            </div>
          )}
        </div>
        <RunBar />
      </section>
      <Canvas
        label="Live layout"
        extent={
          batch ? stack.extent : [0, -width * 0.1, longest.current.length * 1.05, width * 1.1]
        }
        toolbar={
          runJob && (
            <>
              <p className="muted">
                {batch ? 'Validated candidate combination' : 'Live search and best valid layout'}
              </p>
              {!batch && (
                <div className="segmented" role="group" aria-label="Layout shown">
                  <button aria-pressed={showLive} disabled={!frame} onClick={() => setMode('live')}>
                    Live search
                  </button>
                  <button aria-pressed={!showLive} disabled={!best} onClick={() => setMode('best')}>
                    Best valid
                  </button>
                </div>
              )}
              {showLive && (
                <span className="chip">
                  <i className="overlap-key" aria-hidden="true" />
                  Overlaps in red · the search passes through overlapping layouts
                </span>
              )}
            </>
          )
        }
      >
        {({ upp }) =>
          batch ? (
            completed?.map((sheet, index) => {
              const percent = usedUtilization(sheet.job, sheet.result, netArea);
              return (
                <g
                  key={index}
                  transform={`translate(0 ${stack.positions[index].offset})`}
                  role="group"
                  aria-label={`Sheet ${index + 1}`}
                >
                  <text
                    x={0}
                    y={-sheet.job.settings.materialWidthMm - 16 * upp}
                    fontSize={13 * upp}
                    fill="var(--ink)"
                  >
                    {`Sheet ${index + 1}${sheet.job.settings.sheetStock ? ` · ${sheet.job.settings.sheetStock.name}` : ''} · ${sheet.result.placements.length} parts · ${formatPercent(percent)} · ${formatLength(sheet.result.usedLengthMm, unit)} ${unit} used`}
                  </text>
                  <LayoutDrawing
                    job={sheet.job}
                    world={sheetWorlds[index]}
                    usedLength={sheet.result.usedLengthMm}
                    upp={upp}
                  />
                </g>
              );
            })
          ) : displayJob && (showLive ? frame : best) ? (
            <LayoutDrawing
              job={displayJob}
              world={showLive ? frame!.world : bestWorld}
              overlaps={showLive ? frame!.overlaps : []}
              usedLength={shownLength}
              upp={upp}
            />
          ) : null
        }
      </Canvas>
    </div>
  );
}

/** What the next run will solve, shown before the first run of this session. */
function NextRun({ onSolution }: { onSolution?: () => void }) {
  const { project, unit } = useStudio();
  const settings = project.settings;
  const machine = activeMachine(project);
  return (
    <div className="summary">
      <p className="muted">Start nesting from any tab. Progress shows here while sparrow works.</p>
      <dl className="facts">
        <dt>Parts</dt>
        <dd>
          {project.parts.length} types, {copyCount(project.parts)} copies
        </dd>
        <dt>{project.stock.packing === 'sheets' ? 'Sheets' : 'Strip'}</dt>
        <dd>
          {formatLength(project.stock.strip.widthMm, unit)} {unit} wide
          {project.stock.packing === 'sheets' &&
            ` × ${formatLength(project.stock.lengthMm, unit)} ${unit} long · ${project.stock.quantity} available`}
        </dd>
        <dt>Gap</dt>
        <dd>
          {formatLength(machine.gapMm, unit, 3)} {unit} · {machine.name}
        </dd>
        <dt>Stops</dt>
        <dd>
          {settings.timeLimitSeconds
            ? `${project.stock.packing === 'sheets' ? 'total search time: ' : 'after '}${formatSeconds(settings.timeLimitSeconds)}`
            : project.stock.packing === 'sheets'
              ? 'automatic · no total deadline; you can press Stop'
              : 'when the search stalls'}
        </dd>
        <dt>Search</dt>
        <dd>{settings.preset === 'fast' ? 'Fast' : 'Standard'}</dd>
      </dl>
      {onSolution && <button onClick={onSolution}>Show the saved solution</button>}
    </div>
  );
}

/**
 * Utilization of the best valid layout over time, as a step line: each improvement holds until
 * the next. Utilization is plotted by its distance below the current best on a log scale, so even
 * small late improvements show; time runs linearly.
 */
function ImprovementChart({
  history,
  job,
  elapsed,
}: {
  history: Timing[];
  job: Job;
  elapsed: number;
}) {
  const W = 300;
  const H = 110;
  const pad = { left: 44, right: 6, top: 8, bottom: 16 };
  const area = job.parts.reduce((sum, part) => sum + netArea(part) * part.quantity, 0);
  const percent = (lengthMm: number) => (area / (job.settings.materialWidthMm * lengthMm)) * 100;
  const values = history.map((entry) => percent(entry.lengthMm));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const end = Math.max(elapsed * 1000, history.at(-1)!.elapsedMs, 1);
  const x = (ms: number) => pad.left + (ms / end) * (W - pad.left - pad.right);
  // The best sits at the top and the first layout at the bottom; in between, the log distance.
  const floor = Math.max((high - low) * 0.01, 1e-6);
  const depth = (value: number) => Math.log((high - value + floor) / floor);
  const y = (value: number) =>
    high === low
      ? (H - pad.bottom + pad.top) / 2
      : pad.top + (depth(value) / depth(low)) * (H - pad.top - pad.bottom);
  let d = `M${x(history[0].elapsedMs)},${y(values[0])}`;
  history.slice(1).forEach((entry, i) => (d += `H${x(entry.elapsedMs)}V${y(values[i + 1])}`));
  d += `H${x(end)}`;
  const fill = `${d}V${H - pad.bottom}H${x(history[0].elapsedMs)}Z`;
  // Utilization ticks at round distances below the best, kept at least 11 px apart.
  const yTicks: number[] = [];
  for (const value of [high, high - 0.1, high - 1, high - 10, low])
    if (value >= low && yTicks.every((tick) => Math.abs(y(tick) - y(value)) >= 11))
      yTicks.push(value);
  // Time ticks at a round step, about 70 px apart.
  const step = rulerStep(((end / 1000) * 70) / (W - pad.left - pad.right));
  const xTicks = Array.from({ length: Math.floor(end / 1000 / step) + 1 }, (_, i) => i * step);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Utilization over time">
      {yTicks.map((value) => (
        <g key={value}>
          <line className="grid" x1={pad.left} x2={W - pad.right} y1={y(value)} y2={y(value)} />
          <text x={pad.left - 4} y={y(value) + 3} textAnchor="end">
            {formatPercent(value)}
          </text>
        </g>
      ))}
      <path className="area" d={fill} />
      <path className="line" d={d} />
      <line
        className="axis"
        x1={pad.left}
        x2={W - pad.right}
        y1={H - pad.bottom}
        y2={H - pad.bottom}
      />
      {xTicks.map((seconds) => (
        <text key={seconds} x={x(seconds * 1000)} y={H - 3} textAnchor="middle">
          {Number(seconds.toPrecision(6))} s
        </text>
      ))}
    </svg>
  );
}
