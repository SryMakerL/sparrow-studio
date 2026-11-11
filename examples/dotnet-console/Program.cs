using System.Text.Json;
using SparrowStudio.Core;

var part = new Part
{
    Name = "矩形零件",
    Outer = [[0, 0], [100, 0], [100, 50], [0, 50]],
    Quantity = 10,
};
var job = new Job
{
    Name = "C# 原生排版示例",
    Parts = [part],
    Settings = new JobSettings
    {
        MaterialWidthMm = 1000,
        ClearanceMm = 2,
        TimeLimitSeconds = 10,
    },
};
using var cancellation = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
var result = await new NestingSolver().SolveAsync(job, cancellation.Token, seed: 42);
if (result.Placements.Length != part.Quantity ||
    result.Placements.Any(p => p.PartId != part.Id || !double.IsFinite(p.XMm) || !double.IsFinite(p.YMm)))
    throw new InvalidOperationException("Unexpected result mapping.");
Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions(SparrowJson.CreateOptions())
{
    WriteIndented = true,
}));
if (result.Validation.Status != "passed")
    throw new InvalidOperationException("独立几何校验未通过：" + string.Join("; ", result.Validation.Errors));
Console.WriteLine("求解完成，原生独立几何校验通过。");
