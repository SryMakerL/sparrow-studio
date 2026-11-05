using System.Text.Json;
using SparrowStudio.Core;

static void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

var part = new Part { Id = "零件-测试", Outer = [[0, 0], [10, 0], [10, 5], [0, 5]], Quantity = 2, Rotations = new RotationRule { Degrees = [0] } };
var job = new Job
{
    Name = "中文名称", Parts = [part],
    Settings = new JobSettings { MaterialWidthMm = 50, TimeLimitSeconds = 10, SolverPreset = "fast" },
};
var options = SparrowJson.CreateOptions();
using (var document = JsonDocument.Parse(JsonSerializer.Serialize(job, options)))
{
    Check(document.RootElement.GetProperty("parts")[0].GetProperty("outer")[1][0].GetDouble() == 10, "Point array JSON mismatch.");
    Check(document.RootElement.GetProperty("settings").GetProperty("materialWidthMm").GetDouble() == 50, "Settings naming mismatch.");
}
var placementJson = JsonSerializer.Serialize(new Placement { PartId = part.Id, XMm = 12.5, YMm = 7.25 }, options);
using (var document = JsonDocument.Parse(placementJson))
{
    Check(document.RootElement.GetProperty("xMm").GetDouble() == 12.5, "xMm JSON mismatch.");
    Check(document.RootElement.GetProperty("yMm").GetDouble() == 7.25, "yMm JSON mismatch.");
}
Check(JsonSerializer.Deserialize<Placement>(placementJson, options)!.XMm == 12.5, "Coordinate round-trip failed.");
Console.WriteLine("PASS JSON app model round-trip");

var solver = new NestingSolver();
using (var cancelled = new CancellationTokenSource())
{
    cancelled.Cancel();
    try { await solver.SolveAsync(job, cancelled.Token); throw new Exception("Pre-cancel ignored."); }
    catch (OperationCanceledException) { }
}
Console.WriteLine("PASS pre-cancellation");

try { await solver.SolveAsync(job with { Settings = job.Settings with { ClearanceMm = -1 } }); throw new Exception("Invalid input accepted."); }
catch (NestingException) { }
Console.WriteLine("PASS native input error propagation");

try { await solver.SolveAsync(job with { Settings = job.Settings with { SheetCount = 2, SheetLengthMm = 100 } }); throw new Exception("Unsupported inventory accepted."); }
catch (NestingException) { }
Console.WriteLine("PASS unsupported multi-sheet rejection");

var results = await Task.WhenAll(solver.SolveAsync(job, seed: 42), solver.SolveAsync(job, seed: 43));
foreach (var result in results)
{
    Check(result.Placements.Length == 2, "Unexpected placement count.");
    Check(result.Placements.All(p => p.PartId == part.Id), "UTF-8 ID mapping failed.");
    Check(result.Placements.Select(p => p.CopyIndex).Order().SequenceEqual(new[] { 0, 1 }), "Copy indices mismatch.");
    Check(result.Validation.Status == "pending", "Independent validation must not be falsely reported.");
    Check(double.IsFinite(result.UsedLengthMm) && result.UsedLengthMm > 0, "Invalid used length.");
    foreach (var placement in result.Placements)
    {
        Check(Math.Abs(placement.AngleDeg % 180) < 0.001, "Unexpected rotation.");
        Check(placement.XMm >= -0.001 && placement.YMm >= -0.001 &&
            placement.XMm + 10 <= result.UsedLengthMm + 0.001 && placement.YMm + 5 <= 50.001,
            "Rectangle placement is outside the strip.");
    }
    var a = result.Placements[0];
    var b = result.Placements[1];
    Check(a.XMm + 10 <= b.XMm + 0.001 || b.XMm + 10 <= a.XMm + 0.001 ||
        a.YMm + 5 <= b.YMm + 0.001 || b.YMm + 5 <= a.YMm + 0.001, "Rectangle overlap.");
}
Console.WriteLine("PASS concurrent native solves and result mapping");

var finite = await solver.SolveAsync(job with
{
    Settings = job.Settings with
    {
        SheetLengthMm = 100, SheetCount = 1, TimeLimitSeconds = null,
        SheetStock = new SheetStock { WidthMm = 50, LengthMm = 100 },
    },
}, seed: 42);
Check(finite.Placements.Length == 2 && finite.UsedLengthMm <= 100.001, "Finite board length not enforced.");
Console.WriteLine("PASS finite single-sheet constraints");

var polygon = await solver.SolveAsync(job with
{
    Settings = job.Settings with
    {
        SheetLengthMm = 100, SheetCount = 1, TimeLimitSeconds = null,
        SheetStock = new SheetStock
        {
            Kind = "polygon", WidthMm = 50, LengthMm = 100,
            Outer = [[0, 0], [100, 0], [100, 50], [0, 50]],
            Holes = [[[40, 20], [60, 20], [60, 30], [40, 30]]],
        },
    },
}, seed: 42);
Check(polygon.Placements.Length == 2, "Unexpected polygon-stock demand count.");
Check(polygon.Placements.All(p => p.XMm + 10 <= 40.001 || p.XMm >= 59.999 ||
    p.YMm + 5 <= 20.001 || p.YMm >= 29.999), "Part intersects stock hole.");
Console.WriteLine("PASS polygon stock holes");

var cancellationJob = job with
{
    Parts = [part with
    {
        Outer = [[0, 0], [15, 0], [17, 4], [9, 9], [0, 7]],
        Quantity = 200, Rotations = RotationRule.Continuous(),
    }],
    Settings = job.Settings with { MaterialWidthMm = 100, SolverPreset = "standard", TimeLimitSeconds = 600 },
};
using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(50)))
{
    try { await solver.SolveAsync(cancellationJob, cancellation.Token); throw new Exception("In-flight cancellation ignored."); }
    catch (OperationCanceledException) { }
}
Console.WriteLine("PASS in-flight cooperative cancellation");
Console.WriteLine("All 8 managed integration checks passed.");
