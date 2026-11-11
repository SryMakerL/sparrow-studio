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

var multi = await solver.SolveBestAsync(job with
{
    Parts = [part with { Quantity = 3 }],
    Settings = job.Settings with
    {
        MaterialWidthMm = 6, SheetCount = 2, SheetLengthMm = 11,
        TimeLimitSeconds = 10, SheetCompressionSeconds = 1,
        SheetInsertionWarmStartSeconds = 1, SheetInsertionFailures = 1,
    },
}, seed: 42);
Check(multi.Sheets is { Length: 2 }, "Expected two finite boards.");
Check(multi.Sheets!.Sum(s => s.Result.Placements.Length) == 2, "Board demand mismatch.");
Check(multi.Unplaced is { Length: 1 } && multi.Unplaced[0].Quantity == 1, "Unplaced demand conservation failed.");
Check(multi.Validation.Status == "passed", "Aggregate independent validation failed.");
Console.WriteLine("PASS multi-sheet inventory and partial demand conservation");

var results = await Task.WhenAll(solver.SolveAsync(job, seed: 42), solver.SolveAsync(job, seed: 43));
foreach (var result in results)
{
    Check(result.Placements.Length == 2, "Unexpected placement count.");
    Check(result.Placements.All(p => p.PartId == part.Id), "UTF-8 ID mapping failed.");
    Check(result.Placements.Select(p => p.CopyIndex).Order().SequenceEqual(new[] { 0, 1 }), "Copy indices mismatch.");
    Check(result.Validation.Status == "passed" && result.Validation.Errors.Length == 0,
        "Native independent validation did not pass.");
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
Check(finite.Sheets is { Length: 1 } && finite.Sheets[0].Result.Placements.Length == 2 &&
    finite.Sheets[0].Result.UsedLengthMm <= 100.001, "Finite board length not enforced.");
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
Check(polygon.Sheets is { Length: 1 } && polygon.Sheets[0].Result.Placements.Length == 2,
    "Unexpected polygon-stock demand count.");
Check(polygon.Sheets![0].Result.Placements.All(p => p.XMm + 10 <= 40.001 || p.XMm >= 59.999 ||
    p.YMm + 5 <= 20.001 || p.YMm >= 29.999), "Part intersects stock hole.");
Console.WriteLine("PASS polygon stock holes");

var inventory = await solver.SolveBestAsync(job with
{
    Parts = [part with { Quantity = 2, Outer = [[0, 0], [10, 0], [10, 10], [0, 10]] }],
    Settings = job.Settings with
    {
        SheetStocks =
        [
            new SheetStock { Id = "low", WidthMm = 11, LengthMm = 11, Priority = 1 },
            new SheetStock { Id = "high", WidthMm = 11, LengthMm = 11, Priority = 9 },
        ],
        TimeLimitSeconds = 10, SheetCompressionSeconds = 1,
        SheetInsertionWarmStartSeconds = 1, SheetInsertionFailures = 1,
    },
}, seed: 42);
Check(inventory.Sheets is { Length: 2 } && inventory.Sheets[0].Job.Settings.SheetStock?.Id == "high",
    "Mixed inventory did not respect board priority.");
Check(inventory.Validation.Status == "passed" &&
    (inventory.Unplaced is null || inventory.Unplaced.All(p => p.Quantity == 0)), "Mixed inventory validation failed.");
Console.WriteLine("PASS mixed stock priority");

var normalized = await solver.SolveBestAsync(job with
{
    Parts =
    [
        part with { Id = "unused", Quantity = 0 },
        part with { Id = "active", Quantity = 1 },
    ],
    Settings = job.Settings with
    {
        SheetStocks = [new SheetStock
        {
            Id = "translated", Kind = "polygon", WidthMm = 40, LengthMm = 40,
            Outer = [[100, 100], [140, 100], [140, 140], [100, 140], [100, 100]],
            Holes = [],
        }],
        TimeLimitSeconds = 10, SheetCompressionSeconds = 1,
        SheetInsertionWarmStartSeconds = 1, SheetInsertionFailures = 1,
    },
}, seed: 42);
Check(normalized.Validation.Status == "passed" && normalized.Sheets is { Length: 1 } &&
    normalized.Sheets[0].Result.Placements.Single().PartId == "active",
    "Translated stock normalization or zero demand identity failed.");
Console.WriteLine("PASS stock normalization and zero demand catalog identity");

var narrow = await solver.SolveBestAsync(job with
{
    Parts = [part with { Outer = [[0, 0], [4, 0], [4, 4], [0, 4]], Quantity = 2 }],
    Settings = job.Settings with
    {
        MaterialWidthMm = 5, ClearanceMm = 6, SheetLengthMm = 20, SheetCount = 1,
        TimeLimitSeconds = 10, SheetCompressionSeconds = 1,
        SheetInsertionWarmStartSeconds = 1, SheetInsertionFailures = 1,
    },
}, seed: 42);
Check(narrow.Validation.Status == "passed" && narrow.Sheets is { Length: 1 } &&
    narrow.Sheets[0].Result.Placements.Length == 2, "Narrow stock fallback lost feasible demand.");
Console.WriteLine("PASS clearance at or beyond stock width fallback");

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

var partialJob = job with
{
    Parts = [part with { Quantity = 100 }],
    Settings = job.Settings with
    {
        MaterialWidthMm = 11, SheetLengthMm = 11, SheetCount = 100,
        TimeLimitSeconds = 600, SheetCompressionSeconds = 1,
        SheetInsertionWarmStartSeconds = 1, SheetInsertionFailures = 1,
    },
};
using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(150)))
{
    var stopped = await solver.SolveBestAsync(partialJob, cancellation.Token, seed: 42);
    Check(stopped.Validation.Status == "passed", "Cancelled best result failed validation.");
    var placed = stopped.Sheets?.Sum(s => s.Result.Placements.Length) ?? 0;
    var missing = stopped.Unplaced?.Sum(p => p.Quantity) ?? 0;
    Check(placed + missing == 100, "Cancelled partial result lost demand.");
}
Console.WriteLine("PASS cancellation preserving validated best and missing demand");
var sessionJob = job with { Settings = job.Settings with { TimeLimitSeconds = null } };
using (var session = new NestingSession(sessionJob, documentRevision: 19))
{
    var running = session.RunAsync(seed: 42);
    if (!running.IsCompleted)
    {
        try { session.Start(seed: 99); throw new Exception("Overlapping session start was accepted."); }
        catch (InvalidOperationException) { }
    }
    var sessionResult = await running;
    Check(sessionResult.DocumentRevision == 19 && sessionResult.Validation.Status == "passed",
        "Native session result mapping failed.");
    var final = session.Poll();
    Check(final.Status == "finished" && final.Best is not null && final.Sequence > 0,
        "Session did not retain final best and event sequence.");
    Check(solver.Validate(sessionJob, sessionResult).Status == "passed", "Independent revalidation failed.");
    var bad = sessionResult with
    {
        Placements = sessionResult.Placements.Select((p, i) => i == 0 ? p with { XMm = -1000 } : p).ToArray(),
    };
    Check(solver.Validate(sessionJob, bad).Status == "failed", "Validator accepted tampered placement.");
}
Console.WriteLine("PASS native session lifecycle and independent tamper detection");

using (var catalog = new NestingSession(sessionJob))
{
    var step = await catalog.StepAsync(new System.Text.Json.Nodes.JsonObject
    {
        ["quantities"] = new System.Text.Json.Nodes.JsonArray(2),
        ["mode"] = "search", ["budget_ms"] = 2500,
    }, seed: 42);
    Check(step.GetProperty("placements").GetArrayLength() == 2, "Catalog search placements mismatch.");
    var events = catalog.Poll().Events;
    var candidate = events.Last(e => e.GetProperty("type").GetString() == "candidate");
    var snapshotId = candidate.GetProperty("snapshotId").GetUInt32();
    var compressed = await catalog.StepAsync(new System.Text.Json.Nodes.JsonObject
    {
        ["quantities"] = new System.Text.Json.Nodes.JsonArray(2),
        ["mode"] = "compress", ["budget_ms"] = 100,
        ["initial_snapshot"] = snapshotId, ["retain_snapshot"] = snapshotId,
    }, seed: 43);
    Check(compressed.GetProperty("validation").GetProperty("status").GetString() == "passed",
        "Snapshot compression validation failed.");
    try
    {
        await catalog.StepAsync(new System.Text.Json.Nodes.JsonObject
        {
            ["quantities"] = new System.Text.Json.Nodes.JsonArray(2),
            ["initial_snapshot"] = 4294967295u, ["budget_ms"] = 50,
        }, seed: 42);
        throw new Exception("Unknown snapshot was accepted.");
    }
    catch (NestingException) { }
}
Console.WriteLine("PASS persistent native catalog snapshots and compression");
Console.WriteLine("All managed integration checks passed.");
