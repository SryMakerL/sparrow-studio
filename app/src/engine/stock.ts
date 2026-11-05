import polygonClipping from 'polygon-clipping';
import type { Job, SheetStock } from './model';
import { LIMITS } from './model';
import { bounds, normalizePart, area } from './geometry/normalize';

export function normalizeSheetStock(stock: SheetStock): SheetStock {
  if (
    !stock ||
    typeof stock.id !== 'string' ||
    !stock.id ||
    typeof stock.name !== 'string' ||
    !Number.isSafeInteger(stock.quantity) ||
    stock.quantity < 1 ||
    !Number.isInteger(stock.priority) ||
    stock.priority < 0 ||
    stock.priority > 999
  )
    throw Error('Invalid sheet identity, positive safe-integer quantity, or priority (0–999).');
  if (stock.kind === 'rectangle') {
    if (
      ![stock.widthMm, stock.lengthMm].every(
        (n) => Number.isFinite(n) && n > 0 && n <= LIMITS.extent,
      )
    )
      throw Error('Invalid sheet dimensions.');
    return { ...stock };
  }
  if (stock.kind !== 'polygon') throw Error('Unknown sheet kind.');
  const part = normalizePart({
    ...stock,
    source: stock.source ?? { format: 'dxf' },
    approximationToleranceMm: stock.approximationToleranceMm ?? 0,
    rotations: { kind: 'discrete', degrees: [0] },
  });
  const b = bounds(part.outer);
  const shift = (ring: typeof part.outer): typeof part.outer =>
    ring.map(([x, y]) => [x - b[0], y - b[1]]);
  if (b[2] - b[0] > LIMITS.extent || b[3] - b[1] > LIMITS.extent)
    throw Error('Sheet exceeds dimension limit.');
  return {
    ...stock,
    outer: shift(part.outer),
    holes: part.holes.map(shift),
    lengthMm: b[2] - b[0],
    widthMm: b[3] - b[1],
  };
}
export function normalizeSheetStocks(stocks: SheetStock[], allowEmpty = false): SheetStock[] {
  if (!Array.isArray(stocks) || (!allowEmpty && !stocks.length))
    throw Error('Supply at least one sheet stock type.');
  const checked = stocks.map(normalizeSheetStock);
  if (
    new Set(checked.map((s) => s.id)).size !== checked.length
  )
    throw Error('Stock IDs must be unique.');
  return checked;
}
export function jobStocks(job: Job): SheetStock[] {
  return (
    job.settings.sheetStocks ?? [
      {
        id: 'legacy',
        name: 'Sheet',
        kind: 'rectangle',
        widthMm: job.settings.materialWidthMm,
        lengthMm: job.settings.sheetLengthMm!,
        quantity: job.settings.sheetCount!,
        priority: 0,
      },
    ]
  );
}
export function stockArea(stock: SheetStock): number {
  return stock.kind === 'rectangle'
    ? stock.widthMm * stock.lengthMm
    : Math.abs(area(stock.outer)) - stock.holes.reduce((n, h) => n + Math.abs(area(h)), 0);
}
export function usedStockArea(stock: SheetStock, usedLengthMm: number): number {
  const length = Math.min(stock.lengthMm, Math.max(0, usedLengthMm));
  if (stock.kind === 'rectangle') return stock.widthMm * length;
  if (length === 0) return 0;
  if (length === stock.lengthMm) return stockArea(stock);
  const clipped = polygonClipping.intersection(
    [stock.outer, ...stock.holes],
    [
      [
        [0, 0],
        [length, 0],
        [length, stock.widthMm],
        [0, stock.widthMm],
      ],
    ],
  );
  return clipped.reduce(
    (sum, polygon) =>
      sum +
      Math.abs(area(polygon[0])) -
      polygon.slice(1).reduce((holes, ring) => holes + Math.abs(area(ring)), 0),
    0,
  );
}
export const stockGeometryKey = (s: SheetStock) =>
  JSON.stringify([
    s.id,
    s.kind,
    s.widthMm,
    s.lengthMm,
    s.quantity,
    s.priority,
    s.kind === 'polygon' ? [s.outer, s.holes] : null,
  ]);
