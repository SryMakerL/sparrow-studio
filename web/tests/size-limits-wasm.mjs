import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.postMessage = () => {};

for (const variant of ['pkg', 'pkg-nosimd']) {
  const base = new URL(`../wasm/${variant}/`, import.meta.url);
  const wasm = await import(new URL('sparrow_web.js', base));
  wasm.initSync({ module: fs.readFileSync(new URL('sparrow_web_bg.wasm', base)) });
  const items = Array.from({ length: 501 }, (_, id) => ({
    id, demand: id === 0 ? 501 : 1, allowed_orientations: [0],
    shape: { type: 'rectangle', data: { x_min: 0, y_min: 0, width: 1, height: 1 } },
  }));
  const session = new wasm.SheetSession(JSON.stringify({
    name: 'Scale regression', strip_height: 100, stock_length: 100, items,
  }), 0, 'fast');
  try {
    // A missing snapshot is checked after request validation and before any construction.
    for (const quantity of [501, 100001]) {
      assert.throws(() => session.step(JSON.stringify({
        quantities: [quantity, ...Array(500).fill(0)],
        mode: 'compress', budget_ms: 0, initial_snapshot: 4294967295,
      }), '42', () => {}), /Unknown or expired snapshot/);
    }
    assert.throws(() => session.step(JSON.stringify({
      quantities: Array(501).fill(0), mode: 'search', budget_ms: 0,
    }), '42', () => {}), /Invalid session quantities/);
  } finally {
    session.free();
  }
  const path = 'M0 0' + Array.from({ length: 100001 }, (_, i) => i % 2 ? 'L1 1' : 'L1 0').join('') + 'Z';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="${path}"/></svg>`;
  const resolved = JSON.parse(wasm.svg_paths(svg));
  assert.ok(resolved.paths[0].commands.length > 100000);
  console.log(`${variant}: 501 catalog types, demand above 500, request above 100000, SVG segments above 100000 PASS`);
}
