# SparrowStudio.Core：.NET Framework 4.7.2 / C# 7.3

此目录是独立兼容实现，不替换 `packages/dotnet/SparrowStudio.Core`，不要求升级旧 WinForms 客户项目。目标为 Windows x64、.NET Framework 4.7.2，程序集名称和命名空间均为 `SparrowStudio.Core`。

## 构建与真实 smoke

在仓库根目录的 PowerShell 中执行：

```powershell
dotnet build packages/dotnet/framework/tests/SparrowStudio.Core.Framework.Smoke.csproj -c Release
& ./packages/dotnet/framework/tests/bin/Release/net472/SparrowStudio.Core.Framework.Smoke.exe
```

Framework EXE 必须直接运行，不能使用 `dotnet xxx.exe`。该 SDK 风格项目可由本机 .NET SDK 构建；`Microsoft.NETFramework.ReferenceAssemblies` 1.0.3 是微软官方编译期引用程序集包（PrivateAssets=all），在没有本机 4.7.2 targeting pack 时也能构建，不是运行时依赖。运行计算机须安装 .NET Framework 4.7.2 或兼容的较新 4.x 运行时。

原生 release DLL 必须已存在于 `native/dotnet-engine/target/release/sparrow_dotnet_native.dll`。项目只读取并复制此 DLL，不会修改或构建原生工程。

构建 Core（或构建引用它的 smoke）会生成可直接引用分发目录：

```text
packages/dotnet/framework/dist/Release/
  SparrowStudio.Core.dll
  sparrow_dotnet_native.dll
  Newtonsoft.Json.dll
  README.md
```

Debug 构建对应 `dist/Debug/`。Core csproj 将 native DLL 配置为 CopyToOutputDirectory、CopyToPublishDirectory，并带有 NuGet `runtimes/win-x64/native/` 打包元数据；完整 NuGet 发布流程不在本目录范围内。

## 旧 WinForms 接入

1. 引用分发目录的 `SparrowStudio.Core.dll`。Newtonsoft.Json 必须为 NuGet **13.0.1**；客户工程已引用同版时复用其现有引用，避免重复引入。
2. 将 `sparrow_dotnet_native.dll` 复制到 WinForms EXE 同一目录。托管 DLL 和 Newtonsoft.Json.dll 也须可由运行时解析（通常同目录）。只添加托管引用不会自动复制原生 DLL，旧项目需显式设置其复制属性。
3. 客户程序须以 **x64** 运行；不要开启 Prefer 32-bit。库使用 `Environment.Is64BitProcess` 和 Windows 平台检查，拒绝 32 位或非 Windows 进程。原生包仅提供 Windows x64，不包含 ARM64 原生库。原生 release DLL 若有额外系统依赖，由运行环境提供。

```csharp
using Newtonsoft.Json;
using SparrowStudio.Core;

// json 为 Sparrow Studio app 的 Job JSON，而不是引擎 items/strip_height 格式。
Job job = JsonConvert.DeserializeObject<Job>(json, SparrowJson.CreateSettings());
var solver = new NestingSolver();
Result result = await solver.SolveAsync(job, cancellationToken, seed: 42, documentRevision: 1);
string resultJson = JsonConvert.SerializeObject(result, SparrowJson.CreateSettings());
```

WinForms 中应在 async 事件处理器内 await，不要用 `.Result` 阻塞 UI。取消会抛出 `OperationCanceledException`；原生输入或求解错误通过 `NestingException` 返回。

## 模型、JSON 与 API 差异

- `PartSource`、`RotationRule`、`Part`、`SheetStock`、`JobSettings`、`Job`、`Placement`、`Validation`、`Result`、`SheetResult`、`UnplacedPart` 的公共属性名称、类型与默认值尽量保持原版。`SheetResult(Job, Result)` 和 `UnplacedPart(string, int)` 构造函数保留，并增加无参构造便于普通 class/JSON 使用。
- record/init/required 改为 C# 7.3 普通 sealed class/get/set/数组；没有 record 值相等、with、自动解构，也没有 required 编译期检查。原版 nullable 引用类型在此版本为可取 null 的普通引用类型。缺失必要输入仍由 native 校验，不以默认几何或零值掩盖。
- `NestingSolver.SolveAsync(Job, CancellationToken, ulong?, uint)` 与 `NestingException(string)` 保持调用方式；默认 revision=1。未提供 seed 时使用 Framework 的 RandomNumberGenerator.Create().GetBytes(byte[])。
- `SparrowJson.CreateOptions()` 替换为 **`SparrowJson.CreateSettings()`**，返回 Newtonsoft.Json.JsonSerializerSettings；使用 JsonConvert 而非 System.Text.Json。所有属性为 camelCase、忽略 null，Newtonsoft 默认读取时不区分属性名大小写；`XMm`/`YMm` 显式 `[JsonProperty("xMm")]` / `[JsonProperty("yMm")]`，避免缩写命名偏差。
- Newtonsoft.Json PackageReference 精确固定 `[13.0.1]`，分发 DLL 取自还原后的该版本。无其他运行时托管包依赖。

## 原生 ABI 与生命周期

仍使用 Cdecl 五个函数：`sparrow_cancel_create`、`sparrow_cancel_request`、`sparrow_cancel_free`、`sparrow_solve_json`、`sparrow_string_free`。输入使用 Encoding.UTF8 + Marshal.AllocHGlobal + 尾随 NUL，P/Invoke 接收 IntPtr，不依赖 Framework 对 LPUTF8Str 的支持；输出手动扫描 NUL，再复制并严格 UTF-8 解码。

Task.Run 执行同步 native 求解。SafeHandle 持有取消状态，CancellationTokenRegistration 在 native 调用期间存活；先释放响应和输入缓冲区，再 Dispose registration（等待正在执行的回调），最后释放 SafeHandle。取消优先抛 OperationCanceledException，不把原生 cancelled 错误转换成普通 NestingException。

native 当前限制仍保留：单板库存，多板 sheetStocks 等不支持；validation.status 的 pending 不是几何验证已通过。

## smoke 覆盖

`tests/Program.cs` 是 net472/C# 7.3 x64 可执行项目，不使用测试框架包。它真实调用 release native DLL，检查十个矩形的完整放置、唯一 copyIndex、seed/revision、中文及 Unicode partId 的 UTF-8 往返、有限坐标、app Job JSON 输入、xMm/yMm 精确 JSON 名及坐标往返、预取消、非法尺寸的 native 错误、运行中取消。任一断言失败返回非零退出码。
