import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

type Message = {
  type: string;
  phase?: string;
  snapshotId?: number;
  solution?: {
    strip_width: number;
    layout: {
      placed_items: {
        transformation: { rotation: number; translation: [number, number] };
      }[];
    };
  };
};

afterEach(() => vi.unstubAllGlobals());

it.each(['pkg', 'pkg-nosimd'])(
  'runs real compression work for the budget at the geometric bound in compiled %s',
  async (pkg) => {
    const logs: string[] = [];
    vi.stubGlobal('postMessage', (message: { line?: unknown }) => {
      logs.push(String(message.line ?? ''));
    });
    const wasm = await import(`../../web/wasm/${pkg}/sparrow_web.js`);
    wasm.initSync({
      module: readFileSync(
        resolve(import.meta.dirname, '../../web/wasm', pkg, 'sparrow_web_bg.wasm'),
      ),
    });
    const session = new wasm.SheetSession(
      JSON.stringify({
        name: 'near-bound sheet',
        strip_height: 50,
        stock_length: 100.00005,
        items: [
          {
            id: 0,
            demand: 2,
            allowed_orientations: [0],
            shape: {
              type: 'rectangle',
              data: { x_min: 0, y_min: 0, width: 100, height: 10 },
            },
          },
        ],
      }),
      0,
      'fast',
    );
    const run = (request: object) => {
      const messages: Message[] = [];
      session.step(JSON.stringify(request), '42', (text: string) =>
        messages.push(JSON.parse(text)),
      );
      expect(messages.at(-1)?.type).toBe('finished');
      return messages;
    };
    try {
      const cold = run({ quantities: [1], mode: 'search', budget_ms: 0 });
      let snapshot = cold.find((message) => message.type === 'candidate')!;
      expect(snapshot.solution).toBeDefined();
      const initialWidth = snapshot.solution!.strip_width;
      for (let retry = 0; retry < 2; retry++) {
        logs.length = 0;
        const started = performance.now();
        const compressed = run({
          quantities: [1],
          initial_snapshot: snapshot.snapshotId,
          retain_snapshot: snapshot.snapshotId,
          mode: 'compress',
          budget_ms: 150,
        });
        const wallMs = performance.now() - started;
        console.log(`${pkg} compression retry ${retry + 1}: ${wallMs.toFixed(1)} ms / 150 ms`);
        expect(wallMs).toBeGreaterThanOrEqual(140);
        expect(wallMs).toBeLessThan(3000);
        expect(
          compressed.some((message) => message.type === 'phase' && message.phase === 'Compression'),
        ).toBe(true);
        const feasible = compressed.filter((message) => message.type === 'candidate');
        expect(feasible.length).toBeGreaterThan(0);
        for (const message of feasible) {
          expect(message.solution!.strip_width).toBeLessThanOrEqual(initialWidth);
          expect(message.solution!.layout.placed_items).toHaveLength(1);
          const placement = message.solution!.layout.placed_items[0].transformation;
          expect(placement.rotation).toBe(0);
          expect(placement.translation[0]).toBeGreaterThanOrEqual(-0.001);
          expect(placement.translation[0] + 100).toBeLessThanOrEqual(100.00105);
          expect(placement.translation[1]).toBeGreaterThanOrEqual(-0.001);
          expect(placement.translation[1] + 10).toBeLessThanOrEqual(50.001);
        }
        expect(logs.some((line) => /\[SEP\].*finished,/.test(line))).toBe(true);
        const final = feasible.at(-1)!;
        expect(final.solution!.layout.placed_items).not.toEqual(
          snapshot.solution!.layout.placed_items,
        );
        snapshot = final;
      }
    } finally {
      session.free();
    }
  },
  15000,
);
