using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SparrowStudio.Core;

internal static class Program
{
    private static int Main()
    {
        try
        {
            RunAsync().GetAwaiter().GetResult();
            Console.WriteLine("PASS: all net472 / C# 7.3 smoke assertions.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static async Task RunAsync()
    {
        Assert(Environment.OSVersion.Platform == PlatformID.Win32NT && Environment.Is64BitProcess,
            "Smoke requires Windows x64.");
        Assert(typeof(object).Assembly.ImageRuntimeVersion == "v4.0.30319", "Expected Framework CLR v4.");
        Console.WriteLine("Runtime: " + Environment.Version + "; x64=" + Environment.Is64BitProcess);
        var settings = SparrowJson.CreateSettings();
        var sample = new Placement { PartId = "坐标", XMm = 12.5, YMm = -3.25 };
        string coordinateJson = JsonConvert.SerializeObject(sample, settings);
        JObject coordinates = JObject.Parse(coordinateJson);
        Assert(coordinates["xMm"] != null && coordinates["yMm"] != null, "Exact xMm/yMm names.");
        Assert(coordinates["xmm"] == null && coordinates["ymm"] == null, "No incorrect acronym casing.");
        Placement roundtrip = JsonConvert.DeserializeObject<Placement>(coordinateJson, settings);
        Assert(roundtrip.XMm == 12.5 && roundtrip.YMm == -3.25, "Coordinate JSON roundtrip.");
        Placement appCoordinates = JsonConvert.DeserializeObject<Placement>(
            "{\"partId\":\"app\",\"copyIndex\":0,\"xMm\":7.75,\"yMm\":8.5,\"angleDeg\":90}", settings);
        Assert(appCoordinates.XMm == 7.75 && appCoordinates.YMm == 8.5, "App JSON coordinates.");
        Console.WriteLine("PASS: explicit xMm/yMm JSON and roundtrip.");

        var job = new Job
        {
            Name = "矩形排版 / Framework",
            Parts = new Part[]
            {
                new Part
                {
                    Id = "矩形-α",
                    Name = "十个矩形",
                    Outer = new double[][]
                    {
                        new double[] { 0, 0 }, new double[] { 10, 0 },
                        new double[] { 10, 10 }, new double[] { 0, 10 }
                    },
                    Quantity = 10,
                    Rotations = new RotationRule { Degrees = new double[] { 0, 90 } }
                }
            },
            Settings = new JobSettings
            {
                MaterialWidthMm = 40, ClearanceMm = 1, SolverPreset = "fast", TimeLimitSeconds = 10
            }
        };
        string appJson = JsonConvert.SerializeObject(job, settings);
        JObject appObject = JObject.Parse(appJson);
        Assert(appObject["parts"][0]["outer"] != null, "Input uses app Job model.");
        Assert(appObject["items"] == null, "Input is not engine-format JSON.");
        job = JsonConvert.DeserializeObject<Job>(appJson, settings);
        var solver = new NestingSolver();
        Result result = await solver.SolveAsync(job, seed: 42, documentRevision: 7);
        Assert(result.Placements != null && result.Placements.Length == 10, "Ten native placements.");
        Assert(result.DocumentRevision == 7 && result.Seed == "42", "Seed/revision ABI roundtrip.");
        Assert(!string.IsNullOrEmpty(result.SolverRevision), "Native solver revision.");
        Assert(result.UsedLengthMm > 0 && !double.IsNaN(result.UsedLengthMm) &&
            !double.IsInfinity(result.UsedLengthMm), "Finite used length.");
        Assert(result.Validation != null && result.Validation.Status == "pending", "Native validation status.");
        var copies = new HashSet<int>();
        foreach (Placement placement in result.Placements)
        {
            Assert(placement.PartId == "矩形-α", "UTF-8 input and output preserve part ID.");
            Assert(placement.CopyIndex >= 0 && placement.CopyIndex < 10 && copies.Add(placement.CopyIndex),
                "Unique copy indices.");
            Assert(!double.IsNaN(placement.XMm) && !double.IsInfinity(placement.XMm) &&
                !double.IsNaN(placement.YMm) && !double.IsInfinity(placement.YMm), "Finite native coordinates.");
        }
        string resultJson = JsonConvert.SerializeObject(result, settings);
        Result restored = JsonConvert.DeserializeObject<Result>(resultJson, settings);
        Assert(restored.Placements[0].XMm == result.Placements[0].XMm &&
            restored.Placements[0].YMm == result.Placements[0].YMm, "Native coordinates survive JSON.");
        Console.WriteLine("PASS: native rectangle quantity=10; seed=" + result.Seed +
            "; revision=" + result.DocumentRevision + "; usedLengthMm=" + result.UsedLengthMm);

        bool cancelled = false;
        using (var source = new CancellationTokenSource())
        {
            source.Cancel();
            try { await solver.SolveAsync(job, source.Token); }
            catch (OperationCanceledException error)
            {
                cancelled = error.CancellationToken == source.Token;
            }
        }
        Assert(cancelled, "Pre-cancelled token throws OperationCanceledException with same token.");
        Console.WriteLine("PASS: pre-cancellation.");

        job.Settings.MaterialWidthMm = 0;
        bool invalid = false;
        try { await solver.SolveAsync(job, seed: 42); }
        catch (NestingException error)
        {
            invalid = error.Message.IndexOf("Invalid settings", StringComparison.Ordinal) >= 0;
            Console.WriteLine("PASS: invalid input rejected by native: " + error.Message);
        }
        Assert(invalid, "Invalid app-model input raises NestingException from native.");

        job.Settings.MaterialWidthMm = 40;
        bool inFlightCancelled = false;
        using (var source = new CancellationTokenSource())
        {
            Task<Result> running = solver.SolveAsync(job, source.Token, seed: 42);
            source.CancelAfter(100);
            try { await running; }
            catch (OperationCanceledException error)
            {
                inFlightCancelled = error.CancellationToken == source.Token;
            }
        }
        Assert(inFlightCancelled, "Running native operation respects cancellation.");
        Console.WriteLine("PASS: in-flight cancellation and native handle cleanup.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("Assertion failed: " + message);
    }
}
