# SparrowStudio.Core — C# 原生排版库

以新 `app` 的 Job/Part/Result 模型为准，C# 通过 P/Invoke 调用 Rust 原生求解引擎。运行时不需要 Node、浏览器或 WebAssembly。

## 支持范围

- 本目录的原版 NuGet 包面向 .NET 8 及以上，包含 **Windows x64** 原生 DLL；不支持 x86、Unity 或浏览器。
- **旧式 .NET Framework 4.7.2 / C# 7.3 项目请使用 [Framework 兼容版](framework/README.md)**。不要给这类项目安装原版 net8.0 包，也不必为此升级整个 WinForms 项目。使用 `packages.config` 的项目采用普通 DLL 引用即可，详见 [SkiaSharpTest 接入说明](../../docs/imageassist-framework-integration.zh-CN.md)。
- 支持条带排版及单块有限矩形/异形板材、零件数量、优先级、离散/连续旋转、间距、随机种子与协作式取消。
- 不包含 app 的多板库存/多轮调度、持久会话优化、SVG/DXF/PDF 导入导出和独立几何校验。多板请求会明确拒绝，不会默默按一块板计算。
- 零件孔洞按 app 一样保留在模型中，但求解按外轮廓保守处理，不做孔内套料；板材孔洞是禁止放置的区域。
- `Result.Validation.Status` 为 `pending`，表示未执行 app 的独立几何校验。求解成功不等于已经完成制造安全校验，不要把 pending 改成 passed 直接当成验证结果。

## 从源码构建

在仓库根目录可直接使用 PowerShell 一键构建、测试和打包：

```powershell
./packages/dotnet/build.ps1
```

脚本会构建原生 DLL、托管库，运行 Rust 测试和 C# 集成检查，再打包并运行真实 NuGet 消费者。分步执行方式：

```powershell
cargo build --release --manifest-path native/dotnet-engine/Cargo.toml
dotnet build packages/dotnet/SparrowStudio.Core/SparrowStudio.Core.csproj -c Release
dotnet run --project packages/dotnet/tests/SparrowStudio.Core.Tests.csproj -c Release
dotnet run --project examples/dotnet-console/SparrowStudio.Example.csproj -c Release
dotnet pack packages/dotnet/SparrowStudio.Core/SparrowStudio.Core.csproj -c Release -o packages/dotnet/artifacts
```

构建机器需要 .NET SDK、Rust stable 及 Visual Studio C++ Build Tools/Windows SDK；使用已经生成的 NuGet 包只需要 .NET 运行时，无需 Rust。

## 在其他 C# 项目安装

把 `SparrowStudio.Core.0.1.0.nupkg` 放到本地 NuGet 源目录。在你的 C# 项目中执行，替换为实际包目录：

```powershell
dotnet add package SparrowStudio.Core --version 0.1.0 --source "D:\work files\codes\sparrow-studio\packages\dotnet\artifacts"
```

本包尚未发布到 nuget.org。也可以直接添加项目引用，但必须先构建原生 DLL。NuGet 包在 `runtimes/win-x64/native/` 附带 DLL；请发布完整应用输出，不要只复制托管 `SparrowStudio.Core.dll`。C# 进程必须为 x64，不能开启 Prefer 32-bit。

## 最小调用示例

```csharp
using SparrowStudio.Core;

var part = new Part
{
    Name = "矩形零件",
    Outer = [[0, 0], [100, 0], [100, 50], [0, 50]],
    Quantity = 10,
};
var job = new Job
{
    Name = "我的排版",
    Parts = [part],
    Settings = new JobSettings
    {
        MaterialWidthMm = 1000,
        ClearanceMm = 2,
        TimeLimitSeconds = 10,
    },
};
using var cancellation = new CancellationTokenSource();
var result = await new NestingSolver().SolveAsync(
    job, cancellation.Token, seed: 42, documentRevision: 1);

foreach (var placement in result.Placements)
{
    Console.WriteLine($"{placement.PartId} #{placement.CopyIndex}: " +
        $"X={placement.XMm}, Y={placement.YMm}, angle={placement.AngleDeg}");
}
Console.WriteLine($"使用长度：{result.UsedLengthMm} mm");
```

所有长度和坐标单位为毫米；外轮廓和孔洞中的每个点都是 `[x, y]`。默认允许 0°/180°；自由旋转使用 `Rotations = RotationRule.Continuous()`。数组/模型在调用时序列化为快照，求解不会修改调用者数据。

`TimeLimitSeconds` 与 app 一致，使用 10、30、60、120、300、600 或 null；null 为自动停止。时间预算是协作式的，不包含严格的原生构造截止保证。

### 单块板材

在 `JobSettings` 上设置 `SheetLengthMm` 和 `SheetCount = 1`。如需附带板材形状，再提供 `SheetStock`：矩形设置 `Kind = "rectangle"`、`WidthMm`、`LengthMm`；异形另设 `Kind = "polygon"`、`Outer`、`Holes`。`SheetStock.Quantity` 必须为 1，`WidthMm` 必须与 `MaterialWidthMm` 一致，`LengthMm` 必须与 `SheetLengthMm` 一致，轮廓须位于声明尺寸范围内。首版不支持 `SheetStocks` 列表和多板调度，也不支持间距大于或等于板宽的 app 专用几何回退。

```csharp
var sheetJob = job with
{
    Settings = job.Settings with
    {
        SheetLengthMm = 2000,
        SheetCount = 1,
        SheetStock = new SheetStock
        {
            WidthMm = 1000,
            LengthMm = 2000,
            Quantity = 1,
        },
    },
};
var sheetResult = await new NestingSolver().SolveAsync(sheetJob);
```

### WPF / WinForms / ASP.NET

`await solver.SolveAsync(...)` 不会在 UI 线程执行原生计算。WPF/WinForms 的取消按钮调用 `CancellationTokenSource.Cancel()`；ASP.NET 可传入请求的取消令牌。取消是协作式，原生引擎在检查点停止；初始构造可能延迟响应，不能视为强制中断。取消以 `OperationCanceledException` 返回，不返回部分最佳结果。输入非法或未支持的配置抛出 `NestingException`。

并发请求各有独立取消状态，但求解是 CPU 密集型任务；服务端应自行限制并发，避免每个请求占满线程池。

### JSON 互通

```csharp
using System.Text.Json;
var job = JsonSerializer.Deserialize<Job>(json, SparrowJson.CreateOptions())!;
var result = await new NestingSolver().SolveAsync(job);
var output = JsonSerializer.Serialize(result, SparrowJson.CreateOptions());
```

这里只接受 app 的 `Job`，不是带 UI 状态的完整项目文档。C# 使用 PascalCase 属性，JSON 使用原模型 camelCase 字段。

## 已验证结果

- Windows x64 原生 release DLL 构建成功，14 项 Rust 测试通过。
- .NET 8 C# 库构建成功，8 项集成检查通过，覆盖 JSON 字段、中文 ID、错误传播、多板拒绝、并发求解、有限板长、板材孔洞与取消。
- 使用真实 `PackageReference` 从本地 NuGet 包安装，成功求解 10/10 个示例零件；发布到独立目录后再次运行成功。
- 原生 DLL 的 5 个 C ABI 导出已核验；NuGet 包中包含托管 DLL、`runtimes/win-x64/native/sparrow_dotnet_native.dll`、README、LICENSE 和第三方声明。
- 这些检查不等于完整 app 几何验证移植，也不代表所有异形输入都能找到可行解。

## 内存与部署

字符串由原生库分配并由专用释放函数回收；取消对象由 SafeHandle 持有。库在原生调用返回后释放取消注册和句柄，不能在正在执行时卸载 DLL。ABI 使用 UTF-8 JSON 和 Cdecl，Rust panic 在原生边界转成错误响应，但不能恢复原生访问违规或内存耗尽导致的进程终止。这是进程内原生库，不是隔离服务。

MIT 授权；Rust/其他依赖保留自身许可证，包括 jagua-rs 的 MPL-2.0。随包提供仓库 LICENSE 与第三方声明。
