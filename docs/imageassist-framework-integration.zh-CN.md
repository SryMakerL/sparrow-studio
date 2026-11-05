# ImageAssist / SkiaSharpTest 接入说明

检查目标 `SkiaSharpTest.csproj` 后确认：

- 旧式 MSBuild 项目，目标 `.NET Framework 4.7.2`，x64 配置使用 C# 7.3。
- NuGet 使用 `packages.config` 与 `<Reference HintPath=...>`，不是 SDK 风格项目。
- 已引用 `Newtonsoft.Json 13.0.1`。

因此 `dotnet add package` 无法按该项目的现有方式添加引用。更重要的是，之前的 `net8.0` SparrowStudio.Core.dll 不能直接用于此项目。仅改安装命令无法解决框架不兼容。

## 本次方案

使用 `packages/dotnet/framework` 下的 `.NET Framework 4.7.2` 专用兼容版；不升级整个 WinForms 项目，不修改现有排版业务或按钮。

- 将托管库和原生库放入项目的 `lib/SparrowStudio/`。
- 增加 `SparrowStudio.Core.dll` 的普通程序集引用。
- 原生 `sparrow_dotnet_native.dll` 在构建时复制到 EXE 同目录。
- 复用已有 Newtonsoft.Json，不更换 NuGet 管理方式。
- 必须使用 **x64** 配置；x86 和可能以32位运行的 AnyCPU 不适用于这个原生库。

自动安装脚本会先备份 csproj 为 `SkiaSharpTest.csproj.before-sparrow.bak`。不重复覆盖已有备份或已接入的引用。接入仅增加库引用与 DLL 复制配置，不会自动替换现有排版算法或改变按钮行为。

安装后在 Visual Studio 选择 `Debug | x64` 或 `Release | x64`。EXE 同目录须同时有 `SparrowStudio.Core.dll`、`sparrow_dotnet_native.dll` 和现有 `Newtonsoft.Json.dll`，部署时三者都要保留。

如需回退，先关闭 Visual Studio，使用备份还原 csproj，再移除本次新建的 `lib/SparrowStudio` 目录；若接入后又修改过项目文件，不要直接覆盖，先比较差异。

## 接入结果

已在 `D:/work files/2026-10-26/ImageAssist_0527_Standard_test/SkiaSharpTest.csproj` 添加兼容库引用，并保留 `.before-sparrow.bak` 备份。`Debug | x64` 使用 Visual Studio MSBuild 构建成功，生成 `bin/x64/Debug/LCImageAssist.exe`，输出目录中已确认三个必需 DLL 齐全。

独立 net472 测试在 CLR 4.0.30319.42000 / x64 下真实完成 10 个矩形求解、JSON 坐标与中文 ID 往返、预取消、运行中取消及非法输入检查。没有启动客户 WinForms 界面或更改现有排版按钮逻辑。

## C# 7.3 调用示例

```csharp
using SparrowStudio.Core;

var job = new Job
{
    Name = "排版任务",
    Parts = new[]
    {
        new Part
        {
            Name = "矩形零件",
            Outer = new[]
            {
                new[] { 0.0, 0.0 },
                new[] { 100.0, 0.0 },
                new[] { 100.0, 50.0 },
                new[] { 0.0, 50.0 }
            },
            Quantity = 10
        }
    },
    Settings = new JobSettings
    {
        MaterialWidthMm = 1000,
        ClearanceMm = 2,
        TimeLimitSeconds = 10
    }
};
var result = await new NestingSolver().SolveAsync(job);
foreach (var placement in result.Placements)
{
    // placement.XMm / YMm 为原轮廓旋转后的平移量，AngleDeg 为角度。
    // 应用已有绘图逻辑负责将结果映射回对应零件。
}
```

需要从异步方法（例如按钮的 async 事件处理方法）调用，不要使用 `.Wait()` 阻塞 UI。

`Validation.Status` 仍为 `pending`：这只是原生求解绑定，不含 app 的独立几何校验。首版不含多板调度、SVG/DXF/PDF 导入导出。
