using System;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;

namespace SparrowStudio.Core
{
    public sealed class PartSource
    {
        public string Format { get; set; } = "svg";
        public string FileName { get; set; }
        public string EntityId { get; set; }
    }

    public sealed class RotationRule
    {
        public string Kind { get; set; } = "discrete";
        public double[] Degrees { get; set; } = new double[] { 0, 180 };
        public static RotationRule Continuous()
        {
            return new RotationRule { Kind = "continuous", Degrees = null };
        }
    }

    public sealed class Part
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");
        public string Name { get; set; } = "Part";
        public PartSource Source { get; set; } = new PartSource();
        public double[][] Outer { get; set; }
        public double[][][] Holes { get; set; } = new double[0][][];
        public double ApproximationToleranceMm { get; set; }
        public int Quantity { get; set; } = 1;
        public int Priority { get; set; }
        public RotationRule Rotations { get; set; } = new RotationRule();
    }

    public sealed class SheetStock
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");
        public string Name { get; set; } = "Sheet";
        public string Kind { get; set; } = "rectangle";
        public int Quantity { get; set; } = 1;
        public int Priority { get; set; }
        public double WidthMm { get; set; }
        public double LengthMm { get; set; }
        public double[][] Outer { get; set; }
        public double[][][] Holes { get; set; }
        public PartSource Source { get; set; }
        public double? ApproximationToleranceMm { get; set; }
    }

    public sealed class JobSettings
    {
        public SheetStock[] SheetStocks { get; set; }
        public SheetStock SheetStock { get; set; }
        public double? SheetLengthMm { get; set; }
        public int? SheetCount { get; set; }
        public double? SheetInitialSearchSeconds { get; set; }
        public int? SheetCompressionSeconds { get; set; }
        public int? SheetInsertionWarmStartSeconds { get; set; }
        public int? SheetInsertionFailures { get; set; }
        public string SolverPreset { get; set; } = "standard";
        public double MaterialWidthMm { get; set; } = 1000;
        public double ClearanceMm { get; set; }
        public int? TimeLimitSeconds { get; set; }
    }

    public sealed class Job
    {
        public string Name { get; set; } = "Job";
        public Part[] Parts { get; set; }
        public JobSettings Settings { get; set; } = new JobSettings();
    }

    public sealed class Placement
    {
        public string PartId { get; set; }
        public int CopyIndex { get; set; }
        [JsonProperty("xMm")]
        public double XMm { get; set; }
        [JsonProperty("yMm")]
        public double YMm { get; set; }
        public double AngleDeg { get; set; }
    }

    public sealed class Validation
    {
        public string Status { get; set; } = "pending";
        public string Source { get; set; }
        public double? OverlapAreaMm2 { get; set; }
        public double? MaxBoundaryViolationMm { get; set; }
        public double? MinClearanceMm { get; set; }
        public string[] Errors { get; set; } = new string[0];
    }

    public sealed class Result
    {
        public uint DocumentRevision { get; set; }
        public string SolverRevision { get; set; }
        public string Seed { get; set; }
        public double ElapsedSeconds { get; set; }
        public double UsedLengthMm { get; set; }
        public string Reason { get; set; }
        public bool Cancelled { get; set; }
        public uint? SnapshotId { get; set; }
        public Placement[] Placements { get; set; }
        public Validation Validation { get; set; } = new Validation();
        public int? RoundIndex { get; set; }
        public int? CurrentSheetIndex { get; set; }
        public SheetResult[] Sheets { get; set; }
        public UnplacedPart[] Unplaced { get; set; }
    }

    public sealed class SheetResult
    {
        public SheetResult() { }
        public SheetResult(Job job, Result result)
        {
            Job = job;
            Result = result;
        }
        public Job Job { get; set; }
        public Result Result { get; set; }
    }

    public sealed class UnplacedPart
    {
        public UnplacedPart() { }
        public UnplacedPart(string partId, int quantity)
        {
            PartId = partId;
            Quantity = quantity;
        }
        public string PartId { get; set; }
        public int Quantity { get; set; }
    }

    public static class SparrowJson
    {
        public static JsonSerializerSettings CreateSettings()
        {
            return new JsonSerializerSettings
            {
                ContractResolver = new CamelCasePropertyNamesContractResolver(),
                NullValueHandling = NullValueHandling.Ignore
            };
        }
    }
}
