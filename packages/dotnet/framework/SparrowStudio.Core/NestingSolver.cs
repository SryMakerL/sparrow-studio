using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
using Newtonsoft.Json;

namespace SparrowStudio.Core
{
    public sealed class NestingSolver
    {
        public Task<Result> SolveAsync(Job job, CancellationToken cancellationToken = default(CancellationToken),
            ulong? seed = null, uint documentRevision = 1)
        {
            if (job == null) throw new ArgumentNullException(nameof(job));
            if (Environment.OSVersion.Platform != PlatformID.Win32NT || !Environment.Is64BitProcess)
                throw new PlatformNotSupportedException("This package includes the Windows x64 native solver only.");
            cancellationToken.ThrowIfCancellationRequested();
            string json = JsonConvert.SerializeObject(job, SparrowJson.CreateSettings());
            ulong actualSeed = seed ?? CreateSeed();
            return Task.Run(() => Solve(json, actualSeed, documentRevision, cancellationToken));
        }

        public Task<Result> SolveBestAsync(Job job, CancellationToken cancellationToken = default(CancellationToken),
            ulong? seed = null, uint documentRevision = 1)
        {
            if (job == null) throw new ArgumentNullException(nameof(job));
            if (Environment.OSVersion.Platform != PlatformID.Win32NT || !Environment.Is64BitProcess)
                throw new PlatformNotSupportedException("This package includes the Windows x64 native solver only.");
            cancellationToken.ThrowIfCancellationRequested();
            string json = JsonConvert.SerializeObject(job, SparrowJson.CreateSettings());
            ulong actualSeed = seed ?? CreateSeed();
            return Task.Run(() => Solve(json, actualSeed, documentRevision, cancellationToken, true));
        }

        public Validation Validate(Job job, Result result)
        {
            if (job == null) throw new ArgumentNullException(nameof(job));
            if (result == null) throw new ArgumentNullException(nameof(result));
            if (Environment.OSVersion.Platform != PlatformID.Win32NT || !Environment.Is64BitProcess)
                throw new PlatformNotSupportedException("This package includes the Windows x64 native solver only.");
            using (var input = new Utf8Input(JsonConvert.SerializeObject(job, SparrowJson.CreateSettings())))
            using (var output = new Utf8Input(JsonConvert.SerializeObject(result, SparrowJson.CreateSettings())))
                return NativeSessionJson.Read(NativeSessionMethods.Validate(input.Pointer, output.Pointer))
                    .ToObject<Validation>(JsonSerializer.Create(SparrowJson.CreateSettings()));
        }

        private static ulong CreateSeed()
        {
            byte[] bytes = new byte[sizeof(ulong)];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create())
                random.GetBytes(bytes);
            return BitConverter.ToUInt64(bytes, 0);
        }

        private static Result Solve(string json, ulong seed, uint revision, CancellationToken cancellationToken,
            bool preserveBestOnCancellation = false)
        {
            cancellationToken.ThrowIfCancellationRequested();
            using (CancellationHandle cancel = NativeMethods.CreateCancellation())
            {
                if (cancel.IsInvalid)
                    throw new OutOfMemoryException("Unable to allocate native cancellation state.");
                using (CancellationTokenRegistration registration = cancellationToken.Register(
                    () => NativeMethods.RequestCancellation(cancel)))
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(json);
                    IntPtr input = Marshal.AllocHGlobal(checked(bytes.Length + 1));
                    IntPtr response = IntPtr.Zero;
                    try
                    {
                        Marshal.Copy(bytes, 0, input, bytes.Length);
                        Marshal.WriteByte(input, bytes.Length, 0);
                        response = NativeMethods.SolveJson(input, seed, revision, cancel);
                        if (!preserveBestOnCancellation) cancellationToken.ThrowIfCancellationRequested();
                        if (response == IntPtr.Zero)
                            throw new InvalidOperationException("The native solver returned no response.");
                        string text = ReadUtf8(response);
                        SolverResponse envelope = JsonConvert.DeserializeObject<SolverResponse>(
                            text, SparrowJson.CreateSettings());
                        if (envelope == null)
                            throw new InvalidOperationException("The native solver returned an empty response.");
                        if (!envelope.Ok)
                            throw new NestingException(envelope.Error ?? "Native solver failed.");
                        if (envelope.Result == null)
                            throw new InvalidOperationException("The native solver returned no result.");
                        return envelope.Result;
                    }
                    finally
                    {
                        if (response != IntPtr.Zero) NativeMethods.FreeString(response);
                        Marshal.FreeHGlobal(input);
                    }
                }
            }
        }

        private static string ReadUtf8(IntPtr pointer)
        {
            int length = 0;
            while (Marshal.ReadByte(pointer, length) != 0) length = checked(length + 1);
            byte[] bytes = new byte[length];
            Marshal.Copy(pointer, bytes, 0, length);
            return new UTF8Encoding(false, true).GetString(bytes);
        }

        private sealed class SolverResponse
        {
            public bool Ok { get; set; }
            public Result Result { get; set; }
            public string Error { get; set; }
        }
    }

    public sealed class NestingException : Exception
    {
        public NestingException(string message) : base(message) { }
    }

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
        internal static extern IntPtr SolveJson(IntPtr input, ulong seed, uint revision, CancellationHandle cancellation);

        [DllImport(Library, EntryPoint = "sparrow_string_free", CallingConvention = CallingConvention.Cdecl)]
        internal static extern void FreeString(IntPtr value);
    }
}
