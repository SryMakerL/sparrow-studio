using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparrowStudio.Core;

public sealed class NestingSession : IDisposable
{
    private readonly object gate = new();
    private ulong id;
    private bool awaitingOperation;

    public NestingSession(Job job, uint documentRevision = 1)
    {
        ArgumentNullException.ThrowIfNull(job);
        if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64)
            throw new PlatformNotSupportedException("Native sessions require Windows x64.");
        id = NativeSessionJson.Read(NativeSessionMethods.Create(
            JsonSerializer.Serialize(job, SparrowJson.CreateOptions()), documentRevision))
            .GetProperty("sessionId").GetUInt64();
    }

    public void Start(ulong? seed = null)
    {
        lock (gate)
        {
            EnsureAvailable();
            NativeSessionJson.Read(NativeSessionMethods.Start(Handle, seed ?? CreateSeed()));
        }
    }

    public SessionSnapshot Poll()
    {
        lock (gate) return NativeSessionJson.Read(NativeSessionMethods.Poll(Handle))
            .Deserialize<SessionSnapshot>(SparrowJson.CreateOptions())!;
    }

    public void Cancel()
    {
        lock (gate) NativeSessionMethods.Cancel(Handle);
    }

    public Task<Result> RunAsync(IProgress<SessionSnapshot>? progress = null,
        CancellationToken cancellationToken = default, ulong? seed = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (gate)
        {
            EnsureAvailable();
            var activeId = Handle;
            NativeSessionJson.Read(NativeSessionMethods.Start(activeId, seed ?? CreateSeed()));
            awaitingOperation = true;
            return WaitOwnedAsync(activeId, progress, cancellationToken);
        }
    }

    private async Task<Result> WaitOwnedAsync(ulong activeId, IProgress<SessionSnapshot>? progress,
        CancellationToken cancellationToken)
    {
        try { return await WaitAsync(activeId, progress, cancellationToken).ConfigureAwait(false); }
        finally
        {
            lock (gate) awaitingOperation = false;
            GC.KeepAlive(this);
        }
    }

    private void EnsureAvailable()
    {
        if (awaitingOperation) throw new InvalidOperationException("A managed session operation is still in progress.");
    }

    private static async Task<Result> WaitAsync(ulong activeId, IProgress<SessionSnapshot>? progress,
        CancellationToken cancellationToken)
    {
        using var registration = cancellationToken.Register(() => NativeSessionMethods.Cancel(activeId));
        while (true)
        {
            var snapshot = NativeSessionJson.Read(NativeSessionMethods.Poll(activeId))
                .Deserialize<SessionSnapshot>(SparrowJson.CreateOptions())!;
            progress?.Report(snapshot);
            if (snapshot.Status != "running")
            {
                if (snapshot.Error is not null) throw new NestingException(snapshot.Error);
                if (snapshot.Best is not null) return snapshot.Best;
                cancellationToken.ThrowIfCancellationRequested();
                throw new NestingException("Native session finished without a result.");
            }
            await Task.Delay(50).ConfigureAwait(false);
        }
    }

    public Task<JsonElement> StepAsync(JsonObject request, ulong? seed = null)
    {
        ArgumentNullException.ThrowIfNull(request);
        var json = request.ToJsonString();
        lock (gate)
        {
            EnsureAvailable();
            ulong activeId = Handle;
            var actualSeed = seed ?? CreateSeed();
            awaitingOperation = true;
            return Task.Run(() =>
            {
                try { return NativeSessionJson.Read(NativeSessionMethods.Step(activeId, json, actualSeed)); }
                finally
                {
                    lock (gate) awaitingOperation = false;
                    GC.KeepAlive(this);
                }
            });
        }
    }

    private ulong Handle => id != 0 ? id : throw new ObjectDisposedException(nameof(NestingSession));
    private static ulong CreateSeed() => BitConverter.ToUInt64(RandomNumberGenerator.GetBytes(8));

    public void Dispose()
    {
        lock (gate)
        {
            if (id == 0) return;
            NativeSessionMethods.Free(id);
            id = 0;
        }
        GC.SuppressFinalize(this);
    }

    ~NestingSession()
    {
        if (id != 0) NativeSessionMethods.Free(id);
    }
}

public sealed record SessionSnapshot
{
    public ulong SessionId { get; init; }
    public required string Status { get; init; }
    public ulong Sequence { get; init; }
    public JsonElement[] Events { get; init; } = [];
    public Result? Best { get; init; }
    public string? Error { get; init; }
}

internal static class NativeSessionJson
{
    internal static JsonElement Read(IntPtr response)
    {
        if (response == IntPtr.Zero) throw new NestingException("Native session returned no response.");
        try
        {
            using var document = JsonDocument.Parse(Marshal.PtrToStringUTF8(response)
                ?? throw new NestingException("Native session returned invalid UTF-8."));
            var envelope = document.RootElement;
            if (!envelope.GetProperty("ok").GetBoolean())
                throw new NestingException(envelope.GetProperty("error").GetString() ?? "Native session failed.");
            return envelope.GetProperty("result").Clone();
        }
        finally { NativeMethods.FreeString(response); }
    }
}

internal static class NativeSessionMethods
{
    private const string Library = "sparrow_dotnet_native";
    [DllImport(Library, EntryPoint = "sparrow_session_create_json", CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr Create([MarshalAs(UnmanagedType.LPUTF8Str)] string input, uint revision);
    [DllImport(Library, EntryPoint = "sparrow_session_start_json", CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr Start(ulong id, ulong seed);
    [DllImport(Library, EntryPoint = "sparrow_session_poll_json", CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr Poll(ulong id);
    [DllImport(Library, EntryPoint = "sparrow_session_step_json", CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr Step(ulong id, [MarshalAs(UnmanagedType.LPUTF8Str)] string request, ulong seed);
    [DllImport(Library, EntryPoint = "sparrow_session_cancel", CallingConvention = CallingConvention.Cdecl)]
    internal static extern void Cancel(ulong id);
    [DllImport(Library, EntryPoint = "sparrow_session_free", CallingConvention = CallingConvention.Cdecl)]
    internal static extern void Free(ulong id);
    [DllImport(Library, EntryPoint = "sparrow_validate_json", CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr Validate([MarshalAs(UnmanagedType.LPUTF8Str)] string job,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string result);
}
