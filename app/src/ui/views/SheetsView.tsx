import { useId, useState } from 'react';
import { netArea } from '../../engine/geometry/validate';
import { LIMITS, newId, type SheetStock } from '../../engine/model';
import { stockSheets } from '../../project/model';
import { ringsPath } from '../Canvas';
import type { DisplayUnit } from '../../engine/units';
import { Canvas } from '../Canvas';
import { useStudio } from '../context';
import { formatLength } from '../format';
import { ImportMenu } from '../ImportMenu';
import { LengthInput } from '../LengthInput';
import { RunBar } from '../RunBar';

export function SheetsView() {
  const { project, edit, unit } = useStudio();
  const strip = project.stock.strip;
  const [open, setOpen] = useState(true);
  const width = Number.isFinite(strip.widthMm) && strip.widthMm > 0 ? strip.widthMm : 1000;
  const area = project.parts.reduce((sum, part) => sum + netArea(part) * part.quantity, 0);
  // An impression of the length, not a promise: the solver finds the real one.
  const sheets = project.stock.packing === 'sheets' ? project.stock : undefined;
  const inventory = stockSheets(project.stock);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = inventory.find((sheet) => sheet.id === selectedId) ?? inventory[0];
  const setInventory = (items: SheetStock[]) =>
    edit((current) => ({
      ...current,
      stock: {
        packing: 'sheets',
        strip: {
          ...current.stock.strip,
          widthMm: items[0]?.widthMm ?? current.stock.strip.widthMm,
        },
        lengthMm: items[0]?.lengthMm ?? 2440,
        quantity: items.reduce((sum, item) => sum + item.quantity, 0),
        sheets: items,
      },
    }));
  const updateSheet = (change: Partial<SheetStock>) =>
    setInventory(
      inventory.map((sheet) =>
        sheet.id === selected?.id ? ({ ...sheet, ...change } as SheetStock) : sheet,
      ),
    );
  const shown = sheets ? (selected?.lengthMm ?? 2440) : Math.max(width * 1.6, (area / width) * 1.3);
  const shownWidth = sheets ? (selected?.widthMm ?? width) : width;
  const updateStrip = (change: Partial<typeof strip>, key: string) =>
    edit(
      (current) => ({
        ...current,
        stock: { ...current.stock, strip: { ...current.stock.strip, ...change } },
      }),
      key,
    );
  return (
    <div className="view">
      <section className="list-panel" aria-label="Sheets">
        <div className="segmented" role="group" aria-label="Packing">
          <button
            aria-pressed={!sheets}
            onClick={() =>
              edit((current) => ({
                ...current,
                stock: { packing: 'strip', strip: current.stock.strip },
              }))
            }
          >
            Strip
          </button>
          <button
            aria-pressed={!!sheets}
            onClick={() =>
              edit((current) => ({
                ...current,
                stock:
                  current.stock.packing === 'sheets'
                    ? current.stock
                    : {
                        packing: 'sheets',
                        strip: current.stock.strip,
                        lengthMm: 2440,
                        quantity: 10,
                      },
              }))
            }
          >
            Sheets
          </button>
        </div>
        <p className="muted pad">
          {sheets
            ? 'Add rectangular stock or import DXF sheet contours. Higher priority numbers are tried first; equal priorities use list order. Polygon holes are unavailable material. Sparrow treats the outer complement and holes as fixed obstacles. Irregular packing is heuristic; narrow-stock fallback uses sampled free rotations.'
            : 'Parts nest into one strip of fixed width. The solver minimizes the length used.'}
        </p>
        <div className="list-head">
          <span className="label">{sheets ? 'Sheet inventory' : 'Strip'}</span>
          <ImportMenu kind="sheets" files={!!sheets} />
        </div>
        <div className="list-scroll">
          {sheets ? (
            <>
              <div className="pad">
                <button
                  onClick={() => {
                    const sheet: SheetStock = {
                      id: newId(),
                      name: `Rectangle ${inventory.length + 1}`,
                      kind: 'rectangle',
                      widthMm: 1220,
                      lengthMm: 2440,
                      quantity: 1,
                      priority: 0,
                    };
                    setInventory([...inventory, sheet]);
                    setSelectedId(sheet.id);
                  }}
                >
                  Add rectangle
                </button>
              </div>
              {inventory.map((sheet) => (
                <button
                  key={sheet.id}
                  className={sheet.id === selected?.id ? 'row selected' : 'row'}
                  onClick={() => setSelectedId(sheet.id)}
                >
                  <span className="row-text">
                    <span>{sheet.name}</span>
                    <span className="muted mono">
                      {sheet.kind === 'polygon' ? 'Irregular' : 'Rectangle'} ·{' '}
                      {formatLength(sheet.widthMm, unit)} × {formatLength(sheet.lengthMm, unit)}{' '}
                      {unit} · ×{sheet.quantity} · priority {sheet.priority}
                    </span>
                  </span>
                </button>
              ))}
              {selected ? (
                <div className="properties" key={selected.id}>
                  <label className="field">
                    Name
                    <input
                      value={selected.name}
                      onChange={(event) => updateSheet({ name: event.target.value })}
                    />
                  </label>
                  {selected.kind === 'rectangle' ? (
                    <>
                      <LengthInput
                        label="Width"
                        value={selected.widthMm}
                        min={0}
                        max={LIMITS.extent}
                        onChange={(widthMm) => updateSheet({ widthMm })}
                      />
                      <LengthInput
                        label="Length"
                        value={selected.lengthMm}
                        min={0}
                        max={LIMITS.extent}
                        onChange={(lengthMm) => updateSheet({ lengthMm })}
                      />
                    </>
                  ) : (
                    <p className="muted">
                      DXF contour · {selected.outer.length} outer vertices · {selected.holes.length}{' '}
                      holes. Dimensions follow the imported geometry.
                    </p>
                  )}
                  <label className="field">
                    Available sheets
                    <input
                      type="number"
                      min={1}
                      max={500}
                      step={1}
                      value={selected.quantity}
                      onChange={(event) => {
                        const quantity = Number(event.target.value);
                        if (Number.isInteger(quantity) && quantity >= 1 && quantity <= 500)
                          updateSheet({ quantity });
                      }}
                    />
                  </label>
                  <label className="field">
                    Priority (higher first)
                    <input
                      type="number"
                      min={0}
                      max={999}
                      step={1}
                      value={selected.priority}
                      onChange={(event) => {
                        const priority = Number(event.target.value);
                        if (Number.isInteger(priority) && priority >= 0 && priority <= 999)
                          updateSheet({ priority });
                      }}
                    />
                  </label>
                  <button
                    onClick={() =>
                      setInventory(inventory.filter((sheet) => sheet.id !== selected.id))
                    }
                  >
                    Remove stock
                  </button>
                </div>
              ) : (
                <p className="empty">Add a rectangle or import DXF sheet contours.</p>
              )}
            </>
          ) : (
            <>
              <button
                className={open ? 'row selected' : 'row'}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
              >
                <svg className="thumb" viewBox="0 0 36 36" aria-hidden="true">
                  <rect x="2" y="11" width="32" height="14" className="strip-thumb" />
                </svg>
                <span className="row-text">
                  <span>{strip.name}</span>
                  <span className="muted mono">
                    {formatLength(strip.widthMm, unit)} {unit} wide · length open
                  </span>
                </span>
              </button>
              {open && (
                <div className="properties">
                  <label className="field">
                    Name
                    <input
                      value={strip.name}
                      onChange={(event) => updateStrip({ name: event.target.value }, 'strip-name')}
                    />
                  </label>
                  <LengthInput
                    label="Width"
                    value={strip.widthMm}
                    min={0}
                    max={LIMITS.extent}
                    onChange={(widthMm) => updateStrip({ widthMm }, 'strip-width')}
                  />
                  <div className="field">
                    Length
                    <span className="muted">Open: the solver minimizes it.</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <RunBar />
      </section>
      <Canvas
        label={sheets ? 'Rectangular sheet' : 'The strip'}
        extent={[-shownWidth * 0.15, -shownWidth * 0.25, shown, shownWidth * 1.15]}
      >
        {({ upp }) =>
          sheets ? (
            selected?.kind === 'polygon' ? (
              <path
                d={ringsPath([selected.outer, ...selected.holes])}
                fillRule="evenodd"
                fill="var(--sheet)"
                className="sheet-edge"
                strokeWidth={2 * upp}
              />
            ) : selected ? (
              <rect
                x={0}
                y={-shownWidth}
                width={shown}
                height={shownWidth}
                fill="var(--sheet)"
                className="sheet-edge"
                strokeWidth={2 * upp}
              />
            ) : null
          ) : (
            <StripDrawing width={width} length={shown} upp={upp} unit={unit} />
          )
        }
      </Canvas>
    </div>
  );
}

function StripDrawing({
  width,
  length,
  upp,
  unit,
}: {
  width: number;
  length: number;
  upp: number;
  unit: DisplayUnit;
}) {
  const id = useId().replace(/:/g, '');
  const open = length * 0.7;
  const tick = 6 * upp;
  const offset = 18 * upp;
  return (
    <>
      <defs>
        <linearGradient id={`${id}-fade`} x1="0" x2="1">
          <stop offset="0" stopColor="var(--sheet)" stopOpacity="1" />
          <stop offset="1" stopColor="var(--sheet)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x={0} y={-width} width={open} height={width} fill="var(--sheet)" />
      <rect x={open} y={-width} width={length - open} height={width} fill={`url(#${id}-fade)`} />
      <path
        d={`M${length} ${-width}H0V0H${length}`}
        className="sheet-edge"
        strokeWidth={2 * upp}
        fill="none"
      />
      <path
        d={`M${open} ${-width}V0`}
        className="dash"
        strokeWidth={1.2 * upp}
        strokeDasharray={`${6 * upp} ${6 * upp}`}
      />
      <path
        d={`M${-offset} ${-width}V0M${-offset - tick} ${-width}h${2 * tick}M${-offset - tick} 0h${2 * tick}`}
        className="dimension"
        strokeWidth={upp}
      />
      <text
        className="dimension-text"
        fontSize={13 * upp}
        textAnchor="middle"
        transform={`translate(${-offset - 6 * upp} ${-width / 2}) rotate(-90)`}
      >
        {formatLength(width, unit)} {unit}
      </text>
      <text
        className="muted-text"
        x={open / 2}
        y={offset + 4 * upp}
        fontSize={13 * upp}
        textAnchor="middle"
      >
        Length used: found by the solver
      </text>
    </>
  );
}
