using System.Text.Json;
using System.Text.Json.Serialization;

namespace SparrowStudio.Core;

public sealed record PartSource
{
    public string Format { get; init; } = "svg";
    public string? FileName { get; init; }
    public string? EntityId { get; init; }
}

public sealed record RotationRule
{
    public string Kind { get; init; } = "discrete";
    public double[]? Degrees { get; init; } = [0, 180];
    public static RotationRule Continuous() => new() { Kind = "continuous", Degrees = null };
}

public sealed record Part
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N");
    public string Name { get; init; } = "Part";
    public PartSource Source { get; init; } = new();
    public required double[][] Outer { get; init; }
    public double[][][] Holes { get; init; } = [];
    public double ApproximationToleranceMm { get; init; }
    public int Quantity { get; init; } = 1;
    public int Priority { get; init; }
    public RotationRule Rotations { get; init; } = new();
}

public sealed record SheetStock
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N");
    public string Name { get; init; } = "Sheet";
    public string Kind { get; init; } = "rectangle";
    public int Quantity { get; init; } = 1;
    public int Priority { get; init; }
    public required double WidthMm { get; init; }
    public required double LengthMm { get; init; }
    public double[][]? Outer { get; init; }
    public double[][][]? Holes { get; init; }
    public PartSource? Source { get; init; }
    public double? ApproximationToleranceMm { get; init; }
}

public sealed record JobSettings
{
    public SheetStock[]? SheetStocks { get; init; }
    public SheetStock? SheetStock { get; init; }
    public double? SheetLengthMm { get; init; }
    public int? SheetCount { get; init; }
    public bool AutoAddSheets { get; init; } = false;
    public double? SheetInitialSearchSeconds { get; init; }
    public int? SheetCompressionSeconds { get; init; }
    public int? SheetInsertionWarmStartSeconds { get; init; }
    public int? SheetInsertionFailures { get; init; }
    public string SolverPreset { get; init; } = "standard";
    public double MaterialWidthMm { get; init; } = 1000;
    public double ClearanceMm { get; init; }
    public int? TimeLimitSeconds { get; init; }
}

public sealed record Job
{
    public string Name { get; init; } = "Job";
    public required Part[] Parts { get; init; }
    public JobSettings Settings { get; init; } = new();
}

public sealed record Placement
{
    public required string PartId { get; init; }
    public int CopyIndex { get; init; }
    [JsonPropertyName("xMm")]
    public double XMm { get; init; }
    [JsonPropertyName("yMm")]
    public double YMm { get; init; }
    public double AngleDeg { get; init; }
}

public sealed record Validation
{
    public string Status { get; init; } = "pending";
    public string? Source { get; init; }
    public double? OverlapAreaMm2 { get; init; }
    public double? MaxBoundaryViolationMm { get; init; }
    public double? MinClearanceMm { get; init; }
    public string[] Errors { get; init; } = [];
}

public sealed record Result
{
    public uint DocumentRevision { get; init; }
    public required string SolverRevision { get; init; }
    public required string Seed { get; init; }
    public double ElapsedSeconds { get; init; }
    public double UsedLengthMm { get; init; }
    public string? Reason { get; init; }
    public bool Cancelled { get; init; }
    public uint? SnapshotId { get; init; }
    public required Placement[] Placements { get; init; }
    public Validation Validation { get; init; } = new();
    public int? RoundIndex { get; init; }
    public int? CurrentSheetIndex { get; init; }
    public SheetResult[]? Sheets { get; init; }
    public UnplacedPart[]? Unplaced { get; init; }
}

public sealed record SheetResult(Job Job, Result Result);
public sealed record UnplacedPart(string PartId, int Quantity);

public static class SparrowJson
{
    public static JsonSerializerOptions CreateOptions() => new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
