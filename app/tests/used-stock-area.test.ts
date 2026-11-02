import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { importDXF } from '../src/engine/import/dxf';
import { normalizeSheetStock, stockArea, usedStockArea } from '../src/engine/stock';
import { netArea } from '../src/engine/geometry/validate';
import type { SheetStock } from '../src/engine/model';

const stock = (): SheetStock =>
  normalizeSheetStock({
    id: 'concave',
    name: 'Concave',
    kind: 'polygon',
    quantity: 1,
    priority: 0,
    widthMm: 0,
    lengthMm: 0,
    outer: [
      [0, 0],
      [30, 0],
      [30, 10],
      [10, 10],
      [10, 30],
      [0, 30],
    ],
    holes: [
      [
        [2, 2],
        [6, 2],
        [6, 6],
        [2, 6],
      ],
    ],
  });

describe('used stock area', () => {
  it('clips concave material and holes at the used-length boundary', () => {
    const sheet = stock();
    expect(usedStockArea(sheet, 0)).toBe(0);
    expect(usedStockArea(sheet, 4)).toBe(112);
    expect(usedStockArea(sheet, 8)).toBe(224);
    expect(usedStockArea(sheet, 20)).toBe(384);
    expect(usedStockArea(sheet, 30)).toBe(484);
    expect(usedStockArea(sheet, 50)).toBe(stockArea(sheet));
  });

  it('preserves rectangular used-length area', () => {
    const sheet: SheetStock = { ...stock(), kind: 'rectangle', widthMm: 30, lengthMm: 30 };
    expect(usedStockArea(sheet, 8)).toBe(240);
  });

  it('deducts the circle stock hole in the 712.8 mm used region', () => {
    const options = { scale: 1, tolerance: 0.01, enclosed: 'holes' as const };
    const imported = importDXF(
      readFileSync('../test/circle sheet.dxf', 'utf8'),
      'circle sheet.dxf',
      options,
    );
    const parts = importDXF(readFileSync('../test/_6.dxf', 'utf8'), '_6.dxf', options);
    const shape = imported.document.parts[0];
    const sheet = normalizeSheetStock({ ...stock(), outer: shape.outer, holes: shape.holes });
    if (sheet.kind !== 'polygon') throw Error('Expected polygon stock.');
    const used = usedStockArea(sheet, 712.8);
    const withoutHole = usedStockArea({ ...sheet, holes: [] }, 712.8);
    const partsNet = parts.document.parts.reduce((sum, part) => sum + netArea(part) * 40, 0);
    const partsOuter = parts.document.parts.reduce(
      (sum, part) => sum + netArea({ ...part, holes: [] }) * 40,
      0,
    );
    console.log(
      JSON.stringify({
        length: 712.8,
        stockHoleCount: sheet.holes.length,
        usedOuterArea: withoutHole,
        usedNetArea: used,
        deductedStockHole: withoutHole - used,
        partsNet,
        partsOuter,
        netPercent: (partsNet / used) * 100,
        percentIfStockHoleIncluded: (partsNet / withoutHole) * 100,
        outerFootprintPercent: (partsOuter / used) * 100,
      }),
    );
    expect(used).toBeLessThan(withoutHole);
    expect((partsNet / used) * 100).toBeCloseTo(39.93, 1);
  });

  it('reproduces circle sheet and twenty _6 parts at the screenshot length', () => {
    const options = { scale: 1, tolerance: 0.01, enclosed: 'holes' as const };
    const imported = importDXF(
      readFileSync('../test/circle sheet.dxf', 'utf8'),
      'circle sheet.dxf',
      options,
    );
    const parts = importDXF(readFileSync('../test/_6.dxf', 'utf8'), '_6.dxf', options);
    const shape = imported.document.parts[0];
    const sheet = normalizeSheetStock({
      ...stock(),
      outer: shape.outer,
      holes: shape.holes,
    });
    const area = parts.document.parts.reduce((sum, part) => sum + netArea(part) * 20, 0);
    const used = usedStockArea(sheet, 391.1);
    const wholePercent = (area / stockArea(sheet)) * 100;
    const usedPercent = (area / used) * 100;
    console.log(
      JSON.stringify({
        partsArea: area,
        wholeArea: stockArea(sheet),
        usedArea: used,
        wholePercent,
        usedPercent,
      }),
    );
    expect(wholePercent).toBeCloseTo(4.85, 1);
    expect(used).toBeLessThan(391.1 * sheet.widthMm);
    expect(usedPercent).toBeCloseTo(37.92454119, 6);
  });
});
