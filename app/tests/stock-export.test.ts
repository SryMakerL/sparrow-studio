import './svg-wasm';
import { describe, it, expect } from 'vitest';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import parseString from 'dxf/lib/parseString';
import { DEFAULT_SETTINGS, SHEET_LAYER, newPart, type Job, type Result, type Ring, type SheetStock } from '../src/engine/model';
import { normalizeSheetStock, stockArea } from '../src/engine/stock';
import { bounds } from '../src/engine/geometry/normalize';
import { netArea, validate } from '../src/engine/geometry/validate';
import { exportSVG } from '../src/engine/export/svg';
import { exportDXF } from '../src/engine/export/dxf';
import { importSVG } from '../src/engine/import/svg';
import { importDXF } from '../src/engine/import/dxf';

function fixture(stock?: SheetStock) {
  const part = newPart([[0, 0], [4, 0], [4, 4], [0, 4]]);
  part.holes = [[[1, 1], [1, 2], [2, 2], [2, 1]]];
  const doc: Job = {
    name: 'Stock export', parts: [part],
    settings: { ...DEFAULT_SETTINGS, materialWidthMm: 30, sheetLengthMm: 30, ...(stock ? { sheetStock: stock } : {}) },
  };
  const result: Result = {
    documentRevision: 1, solverRevision: 'test', seed: '', elapsedSeconds: 0, usedLengthMm: 14,
    placements: [{ partId: part.id, copyIndex: 0, xMm: 10, yMm: 1, angleDeg: 0 }],
    validation: { status: 'pending', overlapAreaMm2: null, maxBoundaryViolationMm: null, minClearanceMm: null, errors: [] },
  };
  result.validation = validate(doc, result);
  expect(result.validation.status).toBe('passed');
  return { doc, result };
}

const polygon = () => normalizeSheetStock({
  id: 'L', name: 'L with hole', kind: 'polygon', quantity: 1, priority: 0,
  widthMm: 0, lengthMm: 0,
  outer: [[10, 20], [40, 20], [40, 30], [20, 30], [20, 50], [10, 50]],
  holes: [[[12, 22], [12, 26], [16, 26], [16, 22]]],
});

function sheetRings(dxf: string): Ring[] {
  const parsed = parseString(dxf) as { entities: { type: string; layer: string; closed: boolean; vertices: { x: number; y: number }[] }[] };
  return parsed.entities.filter(entity => entity.layer === SHEET_LAYER).map(entity => {
    expect(entity.type).toBe('LWPOLYLINE');
    expect(entity.closed).toBe(true);
    return entity.vertices.map(({ x, y }) => [x, y]);
  });
}

function expectParts(svg: string, dxf: string) {
  const reviews = [
    importSVG(svg, 'layout.svg', { scale: 1, tolerance: .01 }),
    importDXF(dxf, 'layout.dxf', { scale: 1, tolerance: .01, enclosed: 'holes' }),
  ];
  for (const review of reviews) {
    expect(review.issues ?? []).toEqual([]);
    expect(review.document.parts).toHaveLength(1);
    bounds(review.document.parts[0].outer).forEach((value, i) => expect(value).toBeCloseTo([0, 0, 4, 4][i], 6));
    expect(review.document.parts[0].holes).toHaveLength(1);
    expect(netArea(review.document.parts[0])).toBeCloseTo(15);
  }
}

describe('stock boundary export', () => {
  it('exports normalized L stock and its hole, with matching SVG axes and net utilization', () => {
    const stock = polygon();
    if (stock.kind !== 'polygon') throw Error('Expected polygon');
    const { doc, result } = fixture(stock);
    const before = JSON.stringify({ doc, result });
    const bundle = exportSVG(doc, result);
    expect(JSON.stringify({ doc, result })).toBe(before);
    expect(bounds(stock.outer)).toEqual([0, 0, 30, 30]);
    expect(stockArea(stock)).toBe(484);
    expect(bundle.svg).toContain(`${(15 / 484 * 100).toFixed(2)}% used`);
    expect(bundle.svg).toContain('viewBox="-1.5 -1.5 33 33"');
    const xml = new DOMParser().parseFromString(bundle.svg, 'image/svg+xml');
    const sheet = Array.from(xml.getElementsByTagName('path')).find(path => path.getAttribute('id') === SHEET_LAYER)!;
    expect(sheet.getAttribute('fill-rule')).toBe('evenodd');
    expect(sheet.getAttribute('transform')).toBe('translate(0 30) scale(1 -1)');
    expect(sheet.parentNode?.nodeType).toBe(1);
    expect((sheet.parentNode as typeof sheet).getAttribute('data-sparrow-decoration')).toBe('true');
    const rings = (sheet.getAttribute('d')!.match(/M[^MZ]+Z/g) ?? []).map(command => command.slice(1, -1).split('L').map(point => point.split(',').map(Number)));
    expect(rings).toEqual([stock.outer, ...stock.holes]);
    expect(sheetRings(bundle.dxf)).toEqual([stock.outer, ...stock.holes]);
    expectParts(bundle.svg, bundle.dxf);

    // Interpret the stock path itself through the public importers, without the parts or decoration filter.
    const root = xml.documentElement!;
    for (const child of Array.from(root.childNodes)) root.removeChild(child);
    root.appendChild(sheet);
    const svgStock = importSVG(new XMLSerializer().serializeToString(xml), 'stock.svg', { scale: 1, tolerance: .01 });
    const dxfStock = importDXF(bundle.dxf, 'stock.dxf', { scale: 1, tolerance: .01, enclosed: 'holes', layers: [SHEET_LAYER] });
    for (const review of [svgStock, dxfStock]) {
      expect(review.issues ?? []).toEqual([]);
      expect(review.document.parts).toHaveLength(1);
      expect(review.document.parts[0].outer).toHaveLength(6);
      expect(review.document.parts[0].holes).toHaveLength(1);
      expect(netArea(review.document.parts[0])).toBeCloseTo(stockArea(stock));
    }
  });

  it('preserves legacy rectangle SVG and DXF output for explicit rectangular stock', () => {
    const { doc, result } = fixture();
    const legacy = exportSVG(doc, result);
    doc.settings.sheetStock = { id: 'rect', name: 'Rectangle', kind: 'rectangle', quantity: 1, priority: 0, widthMm: 30, lengthMm: 30 };
    const explicit = exportSVG(doc, result);
    expect(explicit.svg).toBe(legacy.svg);
    expect(sheetRings(explicit.dxf)).toEqual(sheetRings(legacy.dxf));
    expect(sheetRings(explicit.dxf)).toEqual([[[0, 0], [30, 0], [30, 30], [0, 30]]]);
    expect(explicit.svg).toContain('<rect x="0" y="0" width="30" height="30"');
    expect(explicit.svg).toContain('1.67% used');
    expectParts(explicit.svg, explicit.dxf);
  });

  it('keeps strip framing at the used length when no stock is selected', () => {
    const { doc, result } = fixture();
    delete doc.settings.sheetLengthMm;
    const bundle = exportSVG(doc, result);
    expect(bundle.svg).toContain('14 × 30 mm');
    expect(bundle.svg).toContain('3.57% used');
    expect(sheetRings(bundle.dxf)).toEqual([[[0, 0], [14, 0], [14, 30], [0, 30]]]);
  });

  it('rejects invalid inventory holes in direct DXF export', () => {
    const stock = polygon();
    if (stock.kind !== 'polygon') throw Error('Expected polygon');
    const { doc } = fixture(stock);
    stock.holes[0][0][0] = NaN;
    expect(() => exportDXF(doc, [], 30)).toThrow('DXF contour is invalid');
  });
});
