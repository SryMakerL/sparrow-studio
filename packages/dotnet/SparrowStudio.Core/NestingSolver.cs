using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace SparrowStudio.Core;

public sealed class NestingSolver
{
    public Task<Result> SolveAsync(Job job, CancellationToken cancellationToken = default,
        ulong? seed = null, uint documentRevision = 1)
    {
        ArgumentNullException.ThrowIfNull(job);
        if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64)
            throw new PlatformNotSupportedException("This package includes the Windows x64 native solver only.");
        cancellationToken.ThrowIfCancellationRequested();
        var json = JsonSerializer.Serialize(job, SparrowJson.CreateOptions());
        var actualSeed = seed ?? BitConverter.ToUInt64(RandomNumberGenerator.GetBytes(sizeof(ulong)));
        return Task.Run(() => Solve(json, actualSeed, documentRevision, cancellationToken));
    }

    private static Result Solve(string json, ulong seed, uint revision, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var cancel = NativeMethods.CreateCancellation();
        if (cancel.IsInvalid) throw new OutOfMemoryException("Unable to allocate native cancellation state.");
        using var registration = cancellationToken.Register(() => NativeMethods.RequestCancellation(cancel));
        var response = NativeMethods.SolveJson(json, seed, revision, cancel);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (response == IntPtr.Zero) throw new InvalidOperationException("The native solver returned no response.");
            var text = Marshal.PtrToStringUTF8(response)
                ?? throw new InvalidOperationException("The native solver returned invalid UTF-8.");
            var envelope = JsonSerializer.Deserialize<SolverResponse>(text, SparrowJson.CreateOptions())
                ?? throw new InvalidOperationException("The native solver returned an empty response.");
            if (!envelope.Ok) throw new NestingException(envelope.Error ?? "Native solver failed.");
            return envelope.Result ?? throw new InvalidOperationException("The native solver returned no result.");
        }
        finally
        {
            if (response != IntPtr.Zero) NativeMethods.FreeString(response);
        }
    }

    private sealed record SolverResponse(bool Ok, Result? Result, string? Error);
}

public sealed class NestingException(string message) : Exception(message);

internal sealed class CancellationHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public CancellationHandle() : base(true) { }
    protected override bool ReleaseHandle()
    {
        NativeMethods.FreeCancellation(handle);
        return true;
    }
}

internal static class NativeMethods
{
    private const string Library = "sparrow_dotnet_native";

    [DllImport(Library, EntryPoint = "sparrow_cancel_create", CallingConvention = CallingConvention.Cdecl)]
    internal static extern CancellationHandle CreateCancellation();

    [DllImport(Library, EntryPoint = "sparrow_cancel_request", CallingConvention = CallingConvention.Cdecl)]
    internal static extern void RequestCancellation(CancellationHandle handle);

    [DllImport(Library, EntryPoint = "sparrow_cancel_free", CallingConvention = CallingConvention.Cdecl)]
    internal static extern void FreeCancellation(IntPtr handle);

    [DllImport(Library, EntryPoint = "sparrow_solve_json", CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr SolveJson([MarshalAs(UnmanagedType.LPUTF8Str)] string input,
        ulong seed, uint revision, CancellationHandle cancellation);

    [DllImport(Library, EntryPoint = "sparrow_string_free", CallingConvention = CallingConvention.Cdecl)]
    internal static extern void FreeString(IntPtr value);
}
