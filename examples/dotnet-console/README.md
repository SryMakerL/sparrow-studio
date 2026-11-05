# C# 原生库调用示例

从仓库根目录执行：

```powershell
cargo build --release --manifest-path native/dotnet-engine/Cargo.toml
dotnet run --project examples/dotnet-console/SparrowStudio.Example.csproj -c Release
```

示例使用 app 模型创建 10 个 100×50 毫米零件，在宽 1000 毫米的条带上，以 2 毫米间距执行求解。输出零件 ID、复制序号、坐标、角度及使用长度。按 Ctrl+C 可请求取消。

`Validation.Status = pending` 是预期行为：这个原生绑定尚未移植 app 的独立几何验证。不要把它当成 passed。

需要 Windows x64、.NET 8+、构建原生引擎所需的 Rust 和 MSVC；安装 NuGet 包的业务应用不需要 Rust。

完整安装与使用方法见 [C# 集成指南](../../packages/dotnet/README.md)。
