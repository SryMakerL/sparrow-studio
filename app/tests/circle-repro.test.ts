import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { importDXF } from '../src/engine/import/dxf';
import { solverInput } from '../src/engine/import/sparrow';
import { normalizeSheetStock } from '../src/engine/stock';
it('prepares circle stock reproduction', () => {
  const opts = { scale: 1, tolerance: 0.01, enclosed: 'holes' as const };
  const sheet = importDXF(
    readFileSync('../test/circle sheet.dxf', 'utf8'),
    'circle sheet.dxf',
    opts,
  );
  const parts = importDXF(readFileSync('../test/_6.dxf', 'utf8'), '_6.dxf', opts);
  expect(sheet.issues).toEqual([]);
  expect(parts.issues).toEqual([]);
  const s = sheet.document.parts[0];
  const stock = normalizeSheetStock({
    id: 'circle',
    name: 'circle',
    kind: 'polygon',
    outer: s.outer,
    holes: s.holes,
    widthMm: 1,
    lengthMm: 1,
    quantity: 1,
    priority: 0,
  });
  const job = {
    name: 'circle _6 x30',
    parts: parts.document.parts.map((p) => ({ ...p, quantity: 30 })),
    settings: {
      ...parts.document.settings,
      materialWidthMm: stock.widthMm,
      sheetLengthMm: stock.lengthMm,
      sheetStock: stock,
      timeLimitSeconds: 10 as const,
    },
  };
  expect(JSON.parse(solverInput(job))).toEqual(
    JSON.parse(readFileSync('../test/circle-repro-input.json', 'utf8')),
  );
  console.log(
    JSON.stringify({
      sheetVertices: s.outer.length,
      holes: s.holes.map((h) => h.length),
      partVertices: job.parts.map((p) => p.outer.length),
      stockWidth: stock.widthMm,
      stockLength: stock.lengthMm,
      warnings: [...sheet.warnings, ...parts.warnings],
    }),
  );
});
