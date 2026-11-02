import { useMemo, useState } from 'react';
import { netArea, worldParts, type WorldPart } from '../../engine/geometry/validate';
import { geometryTask } from '../../engine/workers/geometryTask';
import { projectFileName } from '../../project/file';
import { jobKey, projectJob, utilization, usedUtilization } from '../../project/model';
import { Canvas } from '../Canvas';
import { useStudio } from '../context';
import { download } from '../download';
import { formatArea, formatLength, formatPercent, formatSeconds } from '../format';
import { RunBar } from '../RunBar';
import { sheetStack } from './sheetStack';
import { stockArea } from '../../engine/stock';
import { LayoutDrawing, placementKey } from './LayoutDrawing';
import { PartThumb } from './PartsView';

type Format = 'svg' | 'dxf' | 'pdf';
type Hover = { part: WorldPart; x: number; y: number; sheetIndex?: number };

export function SolutionView() {
  const { project, unit, showError, solver } = useStudio();
  const solution = project.solutions[0];
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheets = solution?.result.sheets;
  const selectedSheet = sheets?.[Math.min(sheetIndex, Math.max(0, sheets.length - 1))];
  const display = selectedSheet ?? solution;
  const [highlight, setHighlight] = useState<string>();
  const [hover, setHover] = useState<Hover>();
  const [busy, setBusy] = useState<Format>();
  const world = useMemo(
    () => (display && (!sheets || selectedSheet) ? worldParts(display.job, display.result) : []),
    [display, sheets, selectedSheet],
  );
  const sheetWorlds = useMemo(
    () => sheets?.map((sheet) => worldParts(sheet.job, sheet.result)) ?? [],
    [sheets],
  );
  const stale = useMemo(
    () => !!solution && jobKey(solution.job) !== jobKey(projectJob(project)),
    [solution, project],
  );

  if (!solution)
    return (
      <div className="view">
        <section className="list-panel" aria-label="Solution">
          <div className="list-head">
            <span className="label">Solution</span>
          </div>
          <div className="list-scroll">
            <div className="empty">
              <p>No solution yet.</p>
              <p className="muted">
                Start nesting. The best valid layout appears here when the run ends.
              </p>
            </div>
          </div>
          <RunBar />
        </section>
        <section className="explanation" aria-label="No solution" />
      </div>
    );

  const { job, result } = display!;
  const width = job.settings.materialWidthMm;
  const sheetLength = job.settings.sheetLengthMm ?? result.usedLengthMm;
  const stack = sheetStack(sheets ?? [], width, sheetLength);
  const partsArea = job.parts.reduce((sum, part) => sum + netArea(part) * part.quantity, 0);
  const waste =
    (job.settings.sheetStock ? stockArea(job.settings.sheetStock) : width * sheetLength) -
    partsArea;
  const placed = job.parts.filter((part) => part.quantity > 0);
  const unplaced = solution.result.unplaced ?? [];
  const totalPlaced = sheets
    ? sheets.reduce((sum, sheet) => sum + sheet.result.placements.length, 0)
    : result.placements.length;
  const names = new Map(solution.job.parts.map((part) => [part.id, part.name]));

  async function exportLayout(format: Format) {
    setBusy(format);
    try {
      const reply = await geometryTask({
        type: 'export',
        runId: 1,
        documentRevision: 1,
        document: job,
        result,
      });
      if (reply.type !== 'export-result') throw Error('Could not export the layout.');
      const name = projectFileName(
        sheets
          ? `${project.name}-sheet-${Math.min(sheetIndex, sheets.length - 1) + 1}`
          : project.name,
        format,
      );
      if (format === 'pdf') {
        const { exportPDF } = await import('../../engine/export/pdf');
        download(name, await exportPDF(reply.bundle.svg), 'application/pdf');
      } else
        download(
          name,
          reply.bundle[format],
          format === 'svg' ? 'image/svg+xml' : 'application/dxf',
        );
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }
  async function diagnostics() {
    const { zip } = await import('../../engine/zip');
    const { reproductionFiles } = await import('../../engine/export/diagnostics');
    const { logs = [], droppedLogs = 0, ...details } = solver.diagnostics.current ?? {};
    download(
      'sparrow-studio-diagnostics.zip',
      zip([
        {
          name: 'diagnostics.json',
          data: JSON.stringify({ project, ...details, droppedLogs }, null, 2),
        },
        ...reproductionFiles(solver.diagnostics.current),
        { name: 'solver.log', data: logs.join('\n') + '\n' },
      ]),
      'application/zip',
    );
  }

  const hovered = hover?.part;
  const hoveredPlacement =
    hovered &&
    (hover?.sheetIndex !== undefined
      ? sheets?.[hover.sheetIndex]?.result
      : result
    )?.placements.find((p) => placementKey(p) === placementKey(hovered));

  return (
    <div className="view">
      <section className="list-panel" aria-label="Solution">
        <div className="list-head">
          <span className="label">Solution</span>
          <span className="muted">{new Date(solution.createdAt).toLocaleString()}</span>
        </div>
        <div className="list-scroll">
          <div className="summary">
            {sheets && (
              <div className="stack">
                <strong>
                  {solution.result.roundIndex !== undefined
                    ? `Best round ${solution.result.roundIndex + 1} · `
                    : 'Best saved plan · '}
                  {sheets.length} sheets used · {totalPlaced} parts placed
                </strong>
                <span className="muted">
                  Total sheet utilization:{' '}
                  {formatPercent(utilization(solution.job, solution.result, netArea))} ·{' '}
                  {formatSeconds(solution.result.elapsedSeconds)} elapsed
                </span>
                <p className="muted">
                  {unplaced.reduce((sum, part) => sum + part.quantity, 0)} parts remain unplaced.
                  Sequential heuristic; minimum sheet count is not guaranteed.
                </p>
                {sheets.length > 0 && (
                  <label className="field">
                    Sheet details and download
                    <select
                      value={Math.min(sheetIndex, sheets.length - 1)}
                      onChange={(event) => {
                        setSheetIndex(Number(event.target.value));
                        setHover(undefined);
                        setHighlight(undefined);
                      }}
                    >
                      {sheets.map((_, index) => (
                        <option key={index} value={index}>
                          Sheet {index + 1}
                          {sheets[index].job.settings.sheetStock
                            ? ` · ${sheets[index].job.settings.sheetStock.name}`
                            : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {unplaced.length > 0 && (
                  <div className="notice">
                    <strong>Unplaced parts</strong>
                    {unplaced.map((part) => (
                      <div key={part.partId}>
                        {names.get(part.partId)} × {part.quantity}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {(!sheets || selectedSheet) && (
              <>
                <div className="metrics">
                  <div className="metric">
                    <span className="metric-value">
                      {formatPercent(usedUtilization(job, result, netArea))}
                    </span>
                    <span className="muted">
                      {sheets ? 'selected sheet used-area utilization' : 'utilization'}
                    </span>
                  </div>
                  <div className="metric">
                    <span className="metric-value">
                      {formatLength(result.usedLengthMm, unit)} <small>{unit}</small>
                    </span>
                    <span className="muted">length used</span>
                  </div>
                </div>
                <dl className="facts">
                  <dt>{sheets ? 'Sheet' : 'Strip'}</dt>
                  <dd>
                    {formatLength(width, unit)} × {formatLength(sheetLength, unit)} {unit}
                  </dd>
                  <dt>Waste</dt>
                  <dd>{formatArea(waste, unit)}</dd>
                  <dt>Placed</dt>
                  <dd>
                    {result.placements.length} parts on this {sheets ? 'sheet' : 'strip'}
                  </dd>
                  <dt>Run</dt>
                  <dd>
                    {solution.stopReason === 'Stopped' ? 'Stopped' : 'Finished'} after{' '}
                    {formatSeconds(solution.result.elapsedSeconds)}
                  </dd>
                </dl>
                {stale && (
                  <p className="notice">
                    The parts or settings changed since this run. Start nesting again to update the
                    solution.
                  </p>
                )}
                <span className="label">Download the layout</span>
                <div className="downloads">
                  {(['svg', 'dxf', 'pdf'] as Format[]).map((format) => (
                    <button
                      key={format}
                      aria-label={`Download ${format.toUpperCase()}`}
                      disabled={!!busy}
                      onClick={() => void exportLayout(format)}
                    >
                      {busy === format ? 'Preparing…' : format.toUpperCase()}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="list-head">
            <span className="label">Parts on this {sheets ? 'sheet' : 'strip'}</span>
            {highlight && (
              <button className="small" onClick={() => setHighlight(undefined)}>
                Show all
              </button>
            )}
          </div>
          {(!sheets || selectedSheet) &&
            placed.map((part) => (
              <button
                key={part.id}
                className={part.id === highlight ? 'row selected' : 'row'}
                aria-pressed={part.id === highlight}
                onClick={() => setHighlight(part.id === highlight ? undefined : part.id)}
              >
                <PartThumb part={part} index={job.parts.indexOf(part)} />
                <span className="row-text">
                  <span>{part.name}</span>
                  <span className="muted">
                    {part.quantity} of {part.quantity} placed
                  </span>
                </span>
              </button>
            ))}
          <div className="pad stack">
            <button className="small" onClick={() => void diagnostics()}>
              Download diagnostics
            </button>
          </div>
        </div>
        <RunBar />
      </section>
      <Canvas
        label="Solution layout"
        extent={sheets ? stack.extent : [0, -width * 0.1, sheetLength * 1.05, width * 1.1]}
        onBackgroundClick={() => setHighlight(undefined)}
        toolbar={
          <span className="chip">
            {sheets
              ? 'All sheets of the best saved round. Select a sheet for details and downloads; select a part to highlight its copies.'
              : 'Select a part type in the list to find its copies. Hover a part for details.'}
          </span>
        }
        overlay={
          hovered &&
          hoveredPlacement && (
            <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
              <strong>
                {names.get(hovered.partId)} · copy {hovered.copyIndex + 1}
              </strong>
              <span className="mono">
                {formatLength(hoveredPlacement.xMm, unit, 2)},{' '}
                {formatLength(hoveredPlacement.yMm, unit, 2)} {unit} ·{' '}
                {Number(hoveredPlacement.angleDeg.toFixed(2))}°
              </span>
            </div>
          )
        }
      >
        {({ upp }) =>
          sheets ? (
            sheets.map((sheet, index) => {
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
                    highlight={highlight}
                    hovered={
                      hover?.sheetIndex === index && hovered ? placementKey(hovered) : undefined
                    }
                    onPick={(part) => {
                      setSheetIndex(index);
                      setHighlight(part.partId === highlight ? undefined : part.partId);
                    }}
                    onHover={(part, event) => {
                      if (!part || !event) return setHover(undefined);
                      const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
                      setHover({
                        part,
                        sheetIndex: index,
                        x: event.clientX - rect.left,
                        y: event.clientY - rect.top,
                      });
                    }}
                  />
                </g>
              );
            })
          ) : (
            <LayoutDrawing
              job={job}
              world={world}
              usedLength={result.usedLengthMm}
              upp={upp}
              highlight={highlight}
              hovered={hovered && placementKey(hovered)}
              onPick={(part) => setHighlight(part.partId === highlight ? undefined : part.partId)}
              onHover={(part, event) => {
                if (!part || !event) return setHover(undefined);
                const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
                setHover({ part, x: event.clientX - rect.left, y: event.clientY - rect.top });
              }}
            />
          )
        }
      </Canvas>
    </div>
  );
}
