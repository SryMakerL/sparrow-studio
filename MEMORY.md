# Project memory

## 板材压缩与 WASM 验证约定

app 实际加载 web/wasm/pkg、pkg-nosimd、pkg-threads、pkg-threads-nosimd 下的编译 WASM。修改 Rust 后必须执行 app 的 npm run wasm:build 生成四种产物，再 npm run build；cargo check 不会更新网页用二进制。板材压缩在几何下界处应继续固定宽度重排直到原 deadline，并通过 sheets.ts 独立 working 布局把同宽有效重排传给下一次补件，不能只修改阶段显示或把同宽重排计为最佳改善。app/tests/compression-budget-wasm.test.ts 直接测实际二进制预算，避免仅 mock 通过；wasm crate 单元测试可能因缺少 test/circle-repro-input.json 无法编译。
