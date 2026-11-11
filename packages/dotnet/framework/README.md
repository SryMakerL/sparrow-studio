# SparrowStudio.Core 0.2.0：.NET Framework 4.7.2 / C# 7.3

Windows x64 原生排版调用层，不要求升级 WinForms 项目。命名空间与程序集为 `SparrowStudio.Core`，调用同一 Rust 原生内核，不依赖浏览器、Node 或 WASM。完整计算能力与边界见上级 `packages/dotnet/README.md`。

## 构建和分发

仓库根目录执行 `./packages/dotnet/build.ps1`，构建并测试原生库、现代 .NET、Framework 和 NuGet 消费者。也可单独执行：

```powershell
cargo build --release --manifest-path native/dotnet-engine/Cargo.toml
dotnet build packages/dotnet/framework/tests/SparrowStudio.Core.Framework.Smoke.csproj -c Release
& ./packages/dotnet/framework/tests/bin/Release/net472/SparrowStudio.Core.Framework.Smoke.exe
```

Framework EXE 直接运行，不能用 `dotnet xxx.exe`。构建使用 Microsoft.NETFramework.ReferenceAssemblies 1.0.3，消费者需 .NET Framework 4.7.2 或兼容的较新 4.x 运行时。

直接引用目录 `packages/dotnet/framework/dist/Release/` 包含：

- `SparrowStudio.Core.dll`
- `sparrow_dotnet_native.dll`
- `Newtonsoft.Json.dll`（13.0.1）
- README、LICENSE、THIRD_PARTY_NOTICES.txt

NuGet 包输出为 `packages/dotnet/artifacts/SparrowStudio.Core.Framework.0.2.0.nupkg`。旧 `packages.config` 项目可直接引用托管 DLL，再把原生 DLL 复制到 EXE 同目录。已有 Newtonsoft.Json 13.0.1 时复用。必须 x64，关闭 Prefer 32-bit。原生 DLL 的 PE 导入已确认依赖 VCRUNTIME140.dll 与 Windows Universal CRT，目标机需对应 x64 VC 运行库。此次不自动修改 ImageAssist 工程。

## 调用

```csharp
using Newtonsoft.Json;
using SparrowStudio.Core;

Job job = JsonConvert.DeserializeObject<Job>(json, SparrowJson.CreateSettings());
var solver = new NestingSolver();
Result result = await solver.SolveBestAsync(job, cancellationToken, seed: 42, documentRevision: 1);
if (result.Sheets != null)
{
    foreach (SheetResult sheet in result.Sheets)
        foreach (Placement p in sheet.Result.Placements)
            Console.WriteLine(p.PartId + ": " + p.XMm + ", " + p.YMm);
}
Validation check = solver.Validate(job, result);
string resultJson = JsonConvert.SerializeObject(result, SparrowJson.CreateSettings());
```

输入为 app Job，不是引擎 items/strip_height 格式或完整 UI 文档。坐标单位 mm，角度为度；XMm/YMm 是原始轮廓刚体变换的平移，不保证等于旋转后包围盒位置。默认旋转 0°/180°。多板 `CopyIndex` 在对应板 job 内编号。

## 能力

- 条带；有限矩形／异形板及禁放孔；多类型库存数量、库存优先级、零件优先级与数量；离散／连续旋转、间距、随机种子。
- `SheetStocks` 或旧 `SheetLengthMm/SheetCount` 多板调度；输出 `Sheets` 与 `Unplaced`，数量守恒。
- `SheetCompressionSeconds`、`SheetInsertionWarmStartSeconds`、`SheetInsertionFailures` 控制阶段预算；时间限制与 app 的 10/30/60/120/300/600/null 一致。
- 独立几何校验、持久单板快照、后台会话和进度事件。
- 零件孔不用于孔内套料；板孔是真实禁区。不包含 SVG/DXF/PDF 导入导出、画布或项目持久化。

## 取消和会话

`SolveAsync` 保持原取消异常行为。新增 `SolveBestAsync` 在运行中取消后保留原生最佳结果；通过 `Result.Reason`、`Unplaced` 和 `Validation` 判断结束状态。调用前已取消仍抛 `OperationCanceledException`。错误输入／原生错误抛 `NestingException`。

```csharp
using (var session = new NestingSession(job, documentRevision: 7))
{
    var progress = new Progress<SessionSnapshot>(snapshot =>
        Console.WriteLine(snapshot.Status + " / " + snapshot.Sequence));
    Result best = await session.RunAsync(progress, cancellationToken, seed: 42);
}
```

也可用 Start/Poll/Cancel 自行驱动。Events 是 JObject[]，Best 是当前保留结果。事件队列上限 256 条，Poll 消费而非广播，新操作清空上一操作未消费的事件；慢消费者可能丢失事件。运行中／错误快照的 Best 不能单独视为本轮已成功，须检查 Status、Error 和 Validation。RunAsync 期间不要另行 Poll 分走进度。底层 StepAsync(JObject, ulong?) 接收 quantities、mode、budget_ms、initial_snapshot、retain_snapshot；仅用于无 aggregate 的单板 catalog。未知／过期 snapshot 明确报错。

时间截止和取消是协作式；DLL 不强杀线程。Dispose 请求取消并移除会话，原生在途操作自行持有生命周期；等待运行任务结束后再卸载库。不要用 `.Result` 阻塞 UI。

## ABI 和模型

Cdecl；UTF-8 输入手工分配，尾随 NUL；返回串由专用函数释放。保留五个旧导出，增加 session create/start/step/poll/cancel/free 及 validate。整数 session ID 不是指针。

Framework 使用普通 sealed class/get/set/数组，不提供现代 record 的 with/required。JSON 使用 camelCase、忽略 null，坐标显式标注 xMm/yMm。Newtonsoft.Json 精确固定 13.0.1；无其他托管运行时包依赖。

Smoke 真实调用 release DLL，覆盖 Unicode、坐标和 revision/seed、独立校验、取消、多板数量守恒、原生会话及篡改结果拒绝。测试失败返回非零；当前结果以本次执行日志为准。
