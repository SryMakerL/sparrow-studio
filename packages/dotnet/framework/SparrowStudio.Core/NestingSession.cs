using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace SparrowStudio.Core
{
    public sealed class NestingSession : IDisposable
    {
        private readonly object gate = new object();
        private ulong id;
        private bool awaitingOperation;

        public NestingSession(Job job, uint documentRevision = 1)
        {
            if (job == null) throw new ArgumentNullException(nameof(job));
            if (Environment.OSVersion.Platform != PlatformID.Win32NT || !Environment.Is64BitProcess)
                throw new PlatformNotSupportedException("Native sessions require Windows x64.");
            using (var input = new Utf8Input(JsonConvert.SerializeObject(job, SparrowJson.CreateSettings())))
                id = NativeSessionJson.Read(NativeSessionMethods.Create(input.Pointer, documentRevision))["sessionId"].Value<ulong>();
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
                .ToObject<SessionSnapshot>(JsonSerializer.Create(SparrowJson.CreateSettings()));
        }

        public void Cancel()
        {
            lock (gate) NativeSessionMethods.Cancel(Handle);
        }

        public Task<Result> RunAsync(IProgress<SessionSnapshot> progress = null,
            CancellationToken cancellationToken = default(CancellationToken), ulong? seed = null)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (gate)
            {
                EnsureAvailable();
                ulong activeId = Handle;
                NativeSessionJson.Read(NativeSessionMethods.Start(activeId, seed ?? CreateSeed()));
                awaitingOperation = true;
                return WaitOwnedAsync(activeId, progress, cancellationToken);
            }
        }

        private async Task<Result> WaitOwnedAsync(ulong activeId, IProgress<SessionSnapshot> progress,
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

        private static async Task<Result> WaitAsync(ulong activeId, IProgress<SessionSnapshot> progress,
            CancellationToken cancellationToken)
        {
            using (cancellationToken.Register(() => NativeSessionMethods.Cancel(activeId)))
            {
                while (true)
                {
                    SessionSnapshot snapshot = NativeSessionJson.Read(NativeSessionMethods.Poll(activeId))
                        .ToObject<SessionSnapshot>(JsonSerializer.Create(SparrowJson.CreateSettings()));
                    if (progress != null) progress.Report(snapshot);
                    if (snapshot.Status != "running")
                    {
                        if (snapshot.Error != null) throw new NestingException(snapshot.Error);
                        if (snapshot.Best != null) return snapshot.Best;
                        cancellationToken.ThrowIfCancellationRequested();
                        throw new NestingException("Native session finished without a result.");
                    }
                    await Task.Delay(50).ConfigureAwait(false);
                }
            }
        }

        public Task<JObject> StepAsync(JObject request, ulong? seed = null)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            string json = request.ToString(Formatting.None);
            lock (gate)
            {
                EnsureAvailable();
                ulong activeId = Handle;
                ulong actualSeed = seed ?? CreateSeed();
                awaitingOperation = true;
                return Task.Run(() =>
                {
                    try
                    {
                        using (var input = new Utf8Input(json))
                            return NativeSessionJson.Read(NativeSessionMethods.Step(activeId, input.Pointer, actualSeed));
                    }
                    finally
                    {
                        lock (gate) awaitingOperation = false;
                        GC.KeepAlive(this);
                    }
                });
            }
        }

        private ulong Handle
        {
            get
            {
                if (id == 0) throw new ObjectDisposedException(nameof(NestingSession));
                return id;
            }
        }

        private static ulong CreateSeed()
        {
            byte[] bytes = new byte[8];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return BitConverter.ToUInt64(bytes, 0);
        }

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

    public sealed class SessionSnapshot
    {
        public ulong SessionId { get; set; }
        public string Status { get; set; }
        public ulong Sequence { get; set; }
        public JObject[] Events { get; set; } = new JObject[0];
        public Result Best { get; set; }
        public string Error { get; set; }
    }

    internal sealed class Utf8Input : IDisposable
    {
        internal IntPtr Pointer { get; private set; }
        internal Utf8Input(string text)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            Pointer = Marshal.AllocHGlobal(checked(bytes.Length + 1));
            Marshal.Copy(bytes, 0, Pointer, bytes.Length);
            Marshal.WriteByte(Pointer, bytes.Length, 0);
        }
        public void Dispose()
        {
            if (Pointer == IntPtr.Zero) return;
            Marshal.FreeHGlobal(Pointer);
            Pointer = IntPtr.Zero;
        }
    }

    internal static class NativeSessionJson
    {
        internal static JObject Read(IntPtr response)
        {
            if (response == IntPtr.Zero) throw new NestingException("Native session returned no response.");
            try
            {
                int length = 0;
                while (Marshal.ReadByte(response, length) != 0) length = checked(length + 1);
                byte[] bytes = new byte[length];
                Marshal.Copy(response, bytes, 0, length);
                JObject envelope = JObject.Parse(new UTF8Encoding(false, true).GetString(bytes));
                if (envelope["ok"] == null || !envelope["ok"].Value<bool>())
                    throw new NestingException((string)envelope["error"] ?? "Native session failed.");
                return (JObject)envelope["result"];
            }
            finally { NativeMethods.FreeString(response); }
        }
    }

    internal static class NativeSessionMethods
    {
        private const string Library = "sparrow_dotnet_native";
        [DllImport(Library, EntryPoint = "sparrow_session_create_json", CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr Create(IntPtr input, uint revision);
        [DllImport(Library, EntryPoint = "sparrow_session_start_json", CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr Start(ulong id, ulong seed);
        [DllImport(Library, EntryPoint = "sparrow_session_poll_json", CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr Poll(ulong id);
        [DllImport(Library, EntryPoint = "sparrow_session_step_json", CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr Step(ulong id, IntPtr request, ulong seed);
        [DllImport(Library, EntryPoint = "sparrow_session_cancel", CallingConvention = CallingConvention.Cdecl)]
        internal static extern void Cancel(ulong id);
        [DllImport(Library, EntryPoint = "sparrow_session_free", CallingConvention = CallingConvention.Cdecl)]
        internal static extern void Free(ulong id);
        [DllImport(Library, EntryPoint = "sparrow_validate_json", CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr Validate(IntPtr job, IntPtr result);
    }
}
