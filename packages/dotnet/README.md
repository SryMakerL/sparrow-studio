# SparrowStudio.Core — C# 原生排版库

以 `app` 的 Job/Part/Result 为接口，Windows x64 原生 DLL 直接执行 Rust Sparrow/Jagua 排版，不需要 Node、浏览器、WebAssembly 或网络服务。版本 0.2.0 将原生子集扩展为排版计算封装；ImageAssist 尚未接入，未修改其工程。

## 能力和边界

- 条带、有限矩形板、带凹边和孔洞的异形板、多类型多数量库存、板材及零件优先级、离散／连续旋转、零件间距、随机种子。
- 多板输出 `Sheets` 与 `Unplaced`，逐板和整体均进行独立几何校验；不能用顶层 `Placements` 代替遍历 `Sheets`。
- 持久单板会话、初始构造、插入与压缩、保留快照；完整任务支持后台原生线程、轮询进度、取消及保留最佳结果。
- 零件孔保留在模型中，碰撞按外轮廓保守处理，不做孔内套料；板材孔是禁止放置区域。
- 这是 app 的**排版计算接口**，不是 UI 或格式转换库；SVG/DXF/PDF 导入导出、画布及 IndexedDB 不属于本 DLL。输入应是已解析的 Job 轮廓。
- 取消和时间预算是协作式；进程内 DLL 不强杀求解线程，不能承诺浏览器 Worker 销毁式硬截止。启发式求解不保证全局最优，也不保证与 WASM 逐坐标相同。

## 构建和交付

仓库根目录执行：

```powershell
./packages/dotnet/build.ps1
```

脚本构建原生 DLL、net8.0 和 net472 两套调用库，运行 Rust、两套托管集成测试及真实 NuGet 消费者。执行 `./packages/dotnet/package-release.ps1` 会在验收后额外生成带 SHA-256 清单的 `SparrowStudio.Native.0.2.0-win-x64.zip` 完整交付包。常规输出：

- `packages/dotnet/artifacts/SparrowStudio.Core.0.2.0.nupkg`：.NET 8+。
- `packages/dotnet/artifacts/SparrowStudio.Core.Framework.0.2.0.nupkg`：.NET Framework 4.7.2 / C# 7.3。
- `packages/dotnet/framework/dist/Release/`：可直接引用的 Framework DLL、原生 DLL、Newtonsoft.Json 及许可证。

构建需要 Rust、.NET SDK、Windows SDK 和 MSVC Build Tools。消费者只需对应 .NET 运行时，必须是 x64，不开启 Prefer 32-bit。部署完整输出，不能只复制托管 DLL。PE 导入核验显示原生 DLL 依赖 `VCRUNTIME140.dll` 和 Windows Universal CRT，目标机器须具备对应 x64 VC 运行库；不是完全静态自包含。Framework 详细说明见 [framework/README.md](framework/README.md)。

```powershell
dotnet add package SparrowStudio.Core --version 0.2.0 --source "D:\work files\codes\sparrow-studio\packages\dotnet\artifacts"
```

## 多板调用

```csharp
using SparrowStudio.Core;

var job = new Job
{
    Name = "生产排版",
    Parts = [new Part
    {
        Id = "part-a",
        Outer = [[0, 0], [100, 0], [100, 50], [0, 50]],
        Quantity = 30,
        Rotations = new RotationRule { Degrees = [0, 90, 180, 270] },
    }],
    Settings = new JobSettings
    {
        MaterialWidthMm = 1000,
        ClearanceMm = 2,
        TimeLimitSeconds = 30,
        SheetStocks = [new SheetStock
        {
            Id = "stock-a", WidthMm = 1000, LengthMm = 2000,
            Quantity = 3, Priority = 1,
        }],
        SheetCompressionSeconds = 10,
        SheetInsertionWarmStartSeconds = 10,
        SheetInsertionFailures = 3,
    },
};

using var stop = new CancellationTokenSource();
var solver = new NestingSolver();
var result = await solver.SolveBestAsync(job, stop.Token, seed: 42);
foreach (var sheet in result.Sheets ?? [])
    foreach (var placement in sheet.Result.Placements)
        Console.WriteLine($"{placement.PartId}: {placement.XMm}, {placement.YMm}, {placement.AngleDeg}°");
foreach (var missing in result.Unplaced ?? [])
    Console.WriteLine($"未放置 {missing.PartId}: {missing.Quantity}");
Console.WriteLine($"结束原因：{result.Reason}；验证：{result.Validation.Status}");
```

所有长度为毫米，点为 `[x, y]`；角度为度。结果坐标表示作用于原始轮廓的旋转和平移，不一定是旋转后包围盒左下角。默认允许 0°/180°；自由旋转用 `RotationRule.Continuous()`。每块板的 `CopyIndex` 对该板 job 而言有效，不是跨板唯一序号。

不设库存和 `SheetCount` 为条带；旧接口 `SheetLengthMm + SheetCount` 仍可生成矩形库存。异形库存设置 `Kind = "polygon"`、`Outer`、`Holes`，由原始板材轮廓归一化。`TimeLimitSeconds` 为 10/30/60/120/300/600/null；null 自动停止。两种阶段时长范围 1–600 秒；插入失败阈值 1–100。

## 取消、进度和独立验证

- `SolveAsync` 保留旧行为：取消抛 `OperationCanceledException`。
- `SolveBestAsync`：运行中取消后，原生返回已验证最佳结果和剩余数量；调用前已取消仍抛异常。输入错误通过 `NestingException` 返回。
- `NestingSession.RunAsync`：后台原生线程执行，定时轮询 `SessionSnapshot`；取消返回保留结果。通过 `IProgress<SessionSnapshot>` 接收状态、事件、sequence、best 和 error。
- `NestingSession.Start/Poll/Cancel` 用于自行驱动；`Dispose` 请求取消并移除句柄，正在运行的原生线程保留自己的所有权。调用方仍须等待运行任务结束后再卸载 DLL。
- `solver.Validate(job, result)` 从原始轮廓重新计算边界、重叠、间距、旋转、数量及库存守恒；篡改输出后可以再次验证，不信任 result 自带的 validation 字段。

```csharp
using var session = new NestingSession(job, documentRevision: 7);
var progress = new Progress<SessionSnapshot>(snapshot =>
    Console.WriteLine($"{snapshot.Status}; events={snapshot.Events.Length}; seq={snapshot.Sequence}"));
var best = await session.RunAsync(progress, stop.Token, seed: 42);
var verification = solver.Validate(job, best);
```

`SessionSnapshot.Events` 保留原生 JSON 事件，适用于插入／压缩进度和候选快照。事件队列为 256 条有界队列，Poll 会消费事件，不是广播；慢消费者可能丢失早期事件，新操作会清空旧操作未消费的事件。Best 独立保留；运行中／错误状态的 Best 不等同于本轮最终成功结果，必须结合 Status、Error 和 Validation 判断。RunAsync 期间不要再手动 Poll 分走其事件。`StepAsync` 是底层持久单板接口，传入与 catalog 类型顺序一致的 `quantities`、`mode`（search/compress/continuous）、`budget_ms`、可选 `initial_snapshot` / `retain_snapshot`。catalog 不应包含 aggregate 库存或 `sheetCount`。候选 snapshot ID 从事件读取；过期 ID 返回错误，不默默重建。完整生产任务优先使用 RunAsync，由原生调度管理快照。

## C ABI

原生导出、参数和字符串所有权以 `native/dotnet-engine/src/lib.rs`、`abi.rs` 及随包头文件为准。旧五个导出保留，并增加 session create/start/step/poll/cancel/free 与 validate。JSON 输入是 NUL 结尾 UTF-8；所有返回 JSON 字符串只能用 `sparrow_string_free` 释放。会话使用整数 ID，不可作为地址解引用；同会话同时只允许一个 start/step，poll/cancel 可并发。

panic 在 ABI 边界转成错误 envelope；访问违规、OOM 或进程终止不属于可恢复错误。库不是隔离服务。

## 测试与授权

`build.ps1` 任一构建、测试或包消费者失败均返回失败。托管验收覆盖中文 ID、模型 JSON、并发求解、有限板、孔、多板缺料守恒、混合库存优先级、窄板大间距、取消、会话和篡改检测；Rust 测试覆盖计算与 ABI 边界。实际执行结果以本次运行日志为准，不将历史通过数写成当前结果。

MIT；依赖保留自己的许可证，包括 Jagua 的 MPL-2.0。分发包含 LICENSE 和 THIRD_PARTY_NOTICES.txt。
