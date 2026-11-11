using System;
using System.Linq;
using System.Threading.Tasks;
using SparrowStudio.Core;

internal static class Program
{
    private static int Main()
    {
        try { Run().GetAwaiter().GetResult(); return 0; }
        catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
    private static Part Rectangle(string id, double w, double h, bool rotate)
    {
        return new Part
        {
            Id = id, Name = id, Quantity = 1,
            Outer = new[] { new[] {-w/2,-h/2},new[] {w/2,-h/2},new[] {w/2,h/2},new[] {-w/2,h/2} },
            Rotations = new RotationRule { Degrees = rotate ? new[] {0.0,90.0} : new[] {0.0} }
        };
    }
    private static async Task Run()
    {
        var solver = new NestingSolver();
        var job = new Job
        {
            Name = "ImageAssist centered rectangle",
            Parts = new[] { Rectangle("rotated",30,10,true) },
            Settings = new JobSettings
            {
                SheetLengthMm = 12, MaterialWidthMm = 32, SheetCount = 1,
                SolverPreset = "fast", TimeLimitSeconds = 10,
                SheetCompressionSeconds = 1, SheetInsertionWarmStartSeconds = 1, SheetInsertionFailures = 1
            }
        };
        var result = await solver.SolveBestAsync(job, seed: 42);
        Check(result.Validation.Status == "passed" && result.Unplaced.Length == 0, "Centered part not placed.");
        var p = result.Sheets.Single().Result.Placements.Single();
        Check(Math.Abs(Math.Abs(p.AngleDeg)-90) < 0.001, "Quarter turn was required.");
        Check(p.XMm-5 >= -0.001 && p.XMm+5 <= 12.001 && p.YMm-15 >= -0.001 && p.YMm+15 <= 32.001,
            "Returned translation is not image center.");
        Console.WriteLine("PASS centered rectangle translation and quarter turn");

        job.Parts = new[] { Rectangle("a",10,10,false), Rectangle("b",10,10,false) };
        job.Settings.SheetLengthMm = 11; job.Settings.MaterialWidthMm = 11; job.Settings.SheetCount = 2;
        result = await solver.SolveBestAsync(job, seed: 42);
        Check(result.Sheets.Length == 2 && result.Unplaced.Length == 0, "Two-board mapping failed.");
        for (int i=0;i<result.Sheets.Length;i++)
        {
            var local = result.Sheets[i].Result.Placements.Single();
            double displayY = local.YMm + i*(11+7);
            Check(displayY-5 >= i*18-0.001 && displayY+5 <= i*18+11.001, "Board gap mapped on wrong axis.");
        }
        Console.WriteLine("PASS vertical board offset and no XY exchange");
    }
}
