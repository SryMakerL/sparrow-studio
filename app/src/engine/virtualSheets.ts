import type { Job, Part, Placement, Result, Ring, SheetStock } from './model';
import { POLICY, SOLVER_REVISION } from './model';
import { area, bounds } from './geometry/normalize';
import { transform } from './geometry/validate';
import { jobStocks, stockArea } from './stock';

export const MAX_VIRTUAL_LENGTH_MM = 10_000_000;
export type VirtualBoard = { stock: SheetStock; xMm: number };
export type VirtualSheet = { job: Job; boards: VirtualBoard[] };

export function canUseStock(part: Part, stock: SheetStock): boolean {
  if (Math.abs(area(part.outer)) > stockArea(stock) + POLICY.overlapMm2) return false;
  if (part.rotations.kind === 'continuous') return true;
  return part.rotations.degrees.some((angleDeg) => {
    const box = bounds(
      transform(part.outer, { angleDeg, xMm: 0, yMm: 0, partId: part.id, copyIndex: 0 }),
    );
    return (
      box[2] - box[0] <= stock.lengthMm + POLICY.linearMm &&
      box[3] - box[1] <= stock.widthMm + POLICY.linearMm
    );
  });
}

export function orderedStocks(job: Job): SheetStock[] {
  return jobStocks(job)
    .filter((stock) => job.parts.some((part) => part.quantity > 0 && canUseStock(part, stock)))
    .sort((a, b) => b.priority - a.priority || stockArea(b) - stockArea(a));
}

export function selectBoards(job: Job, parts: Part[], utilization = 0.8): SheetStock[] {
  const stocks = orderedStocks({ ...job, parts });
  const chosen: SheetStock[] = [];
  const counts = new Map<string, number>();
  let capacity = 0,
    virtualLength = 0;
  const separator = Math.max(1, job.settings.clearanceMm);
  const demand = parts.reduce((sum, part) => sum + Math.abs(area(part.outer)) * part.quantity, 0);
  const add = (stock: SheetStock, count: number) => {
    count = Math.max(
      0,
      Math.min(
        count,
        stock.quantity - (counts.get(stock.id) ?? 0),
        1000 - chosen.length,
        Math.floor(
          (MAX_VIRTUAL_LENGTH_MM - virtualLength + (chosen.length ? 0 : separator)) /
            (stock.lengthMm + separator),
        ),
      ),
    );
    const hadBoards = chosen.length > 0;
    for (let i = 0; i < count; i++) chosen.push(stock);
    counts.set(stock.id, (counts.get(stock.id) ?? 0) + count);
    capacity += stockArea(stock) * count;
    if (count) virtualLength += count * (stock.lengthMm + separator) - (hadBoards ? 0 : separator);
  };
  // Ensure a large or direction-constrained part has at least one compatible board.
  for (const part of [...parts].sort((a, b) => Math.abs(area(b.outer)) - Math.abs(area(a.outer)))) {
    if (part.quantity === 0 || chosen.some((stock) => canUseStock(part, stock))) continue;
    const stock = stocks.find((stock) => canUseStock(part, stock));
    if (stock) add(stock, 1);
  }
  for (const stock of stocks) {
    if (capacity >= demand / utilization) break;
    add(stock, Math.ceil((demand / utilization - capacity) / stockArea(stock)));
  }
  return chosen.sort((a, b) => b.priority - a.priority || stockArea(b) - stockArea(a));
}

export function stitchBoards(input: Job, stocks: SheetStock[], parts = input.parts): VirtualSheet {
  if (!stocks.length || stocks.length > 1000)
    throw Error('A virtual sheet requires between 1 and 1000 physical boards.');
  const height = Math.max(...stocks.map((stock) => stock.widthMm));
  // Keep the separator representable by f32 even near the virtual coordinate limit.
  const separator = Math.max(1, input.settings.clearanceMm);
  let length = 0;
  const boards = stocks.map((stock) => {
    const board = { stock, xMm: length };
    length += stock.lengthMm + separator;
    return board;
  });
  length -= separator;
  if (length > MAX_VIRTUAL_LENGTH_MM)
    throw Error('The stitched sheet exceeds the 10,000,000 mm virtual length limit.');
  const shift = (ring: Ring, xMm: number): Ring => ring.map(([x, y]) => [x + xMm, y]);
  const virtualBoards = boards.map(({ stock, xMm }) => ({
    outer: shift(
      stock.kind === 'polygon'
        ? stock.outer
        : [
            [0, 0],
            [stock.lengthMm, 0],
            [stock.lengthMm, stock.widthMm],
            [0, stock.widthMm],
          ],
      xMm,
    ),
    holes: stock.kind === 'polygon' ? stock.holes.map((ring) => shift(ring, xMm)) : [],
  }));
  const {
    sheetCount: _count,
    sheetStocks: _stocks,
    sheetStock: _stock,
    ...settings
  } = input.settings;
  return {
    boards,
    job: {
      ...input,
      parts,
      settings: {
        ...settings,
        materialWidthMm: height,
        sheetLengthMm: length,
        virtualBoards,
        timeLimitSeconds: 10,
      },
    },
  };
}

export function splitVirtualResult(
  input: Job,
  virtual: VirtualSheet,
  candidate: Result,
  revision = 0,
): Result | undefined {
  if (
    candidate.sheets ||
    candidate.unplaced ||
    !Number.isFinite(candidate.usedLengthMm) ||
    candidate.usedLengthMm <= 0 ||
    candidate.usedLengthMm > virtual.job.settings.sheetLengthMm! + POLICY.linearMm
  )
    return;
  const identities = new Map(virtual.job.parts.map((part) => [part.id, part]));
  const groups: Placement[][] = virtual.boards.map(() => []);
  const seen = new Set<string>();
  if (
    candidate.placements.length !== virtual.job.parts.reduce((sum, part) => sum + part.quantity, 0)
  )
    return;
  for (const placement of candidate.placements) {
    const part = identities.get(placement.partId);
    if (
      !part ||
      !Number.isInteger(placement.copyIndex) ||
      placement.copyIndex < 0 ||
      placement.copyIndex >= part.quantity ||
      ![placement.xMm, placement.yMm, placement.angleDeg].every(Number.isFinite)
    )
      return;
    const key = JSON.stringify([placement.partId, placement.copyIndex]);
    if (seen.has(key)) return;
    seen.add(key);
    const box = bounds(transform(part.outer, placement));
    if (box[2] > candidate.usedLengthMm + POLICY.linearMm) return;
    const boardIndex = virtual.boards.findIndex(
      ({ stock, xMm }) =>
        box[0] >= xMm - POLICY.linearMm &&
        box[2] <= xMm + stock.lengthMm + POLICY.linearMm &&
        box[1] >= -POLICY.linearMm &&
        box[3] <= stock.widthMm + POLICY.linearMm,
    );
    if (boardIndex < 0) return;
    groups[boardIndex].push({ ...placement, xMm: placement.xMm - virtual.boards[boardIndex].xMm });
  }
  const totals = new Map<string, number>();
  const sheets = virtual.boards.flatMap(({ stock }, index) => {
    const placements = groups[index];
    if (!placements.length) return [];
    const copies = new Map<string, number>();
    for (const placement of placements) {
      placement.copyIndex = copies.get(placement.partId) ?? 0;
      copies.set(placement.partId, placement.copyIndex + 1);
      totals.set(placement.partId, (totals.get(placement.partId) ?? 0) + 1);
    }
    const parts = input.parts
      .filter((part) => copies.has(part.id))
      .map((part) => ({ ...part, quantity: copies.get(part.id)! }));
    const {
      sheetCount: _count,
      sheetStocks: _stocks,
      virtualBoards: _virtual,
      ...settings
    } = input.settings;
    const job: Job = {
      ...input,
      parts,
      settings: {
        ...settings,
        sheetStock: stock,
        sheetLengthMm: stock.lengthMm,
        materialWidthMm: stock.widthMm,
      },
    };
    const usedLengthMm = Math.min(
      stock.lengthMm,
      Math.max(
        ...placements.map(
          (placement) => bounds(transform(identities.get(placement.partId)!.outer, placement))[2],
        ),
      ) + input.settings.clearanceMm,
    );
    return [
      {
        job,
        result: {
          ...candidate,
          documentRevision: revision,
          placements,
          usedLengthMm,
          validation: { ...candidate.validation, status: 'pending' as const },
        },
      },
    ];
  });
  return {
    documentRevision: revision,
    solverRevision: SOLVER_REVISION,
    seed: candidate.seed,
    elapsedSeconds: candidate.elapsedSeconds,
    placements: [],
    sheets,
    usedLengthMm: sheets.reduce((sum, sheet) => sum + sheet.result.usedLengthMm, 0),
    unplaced: input.parts
      .filter((part) => part.quantity > (totals.get(part.id) ?? 0))
      .map((part) => ({ partId: part.id, quantity: part.quantity - (totals.get(part.id) ?? 0) })),
    validation: { ...candidate.validation, status: 'pending' },
  };
}
