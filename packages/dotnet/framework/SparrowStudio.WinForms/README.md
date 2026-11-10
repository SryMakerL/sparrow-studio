# Sparrow Studio WinForms preview

Windows x64 / .NET Framework 4.7.2 / C# 7.3. A reusable offline WebView2 preview over the existing SparrowStudio.Core native session, not a React/WASM host.

```csharp
using (var dialog = new SparrowStudio.WinForms.NestingPreviewDialog(job))
{
    // Optional, before ShowDialog: dialog.UserDataFolder = writableProfileDirectory;
    if (dialog.ShowDialog(owner) == DialogResult.OK)
    {
        var result = dialog.Result; // host-owned, independently validated, fully placed
        // Independently validate against the original job before committing application changes.
    }
}
```

Open the dialog, click Start, inspect Best / Current round, then Apply result. Cancellation and window close never apply a candidate. Closing during a solve cancels and awaits native termination; it does not kill the solver. Failure is visible in the page (or a native initialization message) and the window remains closable. Current round and best are only actual native snapshots; there is no simulated motion or second polling consumer.

## Build and direct references

`dotnet build SparrowStudio.WinForms.csproj -c Release` produces `../dist/WinForms/Release`. Reference SparrowStudio.WinForms.dll, SparrowStudio.Core.dll, Newtonsoft.Json.dll and both Microsoft.Web.WebView2.Core.dll / Microsoft.Web.WebView2.WinForms.dll. Deploy those plus x64 WebView2Loader.dll and the existing sparrow_dotnet_native.dll beside the application. Retain LICENSE, LICENSE.txt (WebView2) and THIRD_PARTY_NOTICES.txt. Newtonsoft.Json is pinned to 13.0.1; WebView2 SDK to 1.0.3179.45 (net462-compatible assets). No packages.config changes are required for a legacy application.

Microsoft Edge WebView2 Evergreen Runtime must already be installed. Missing-runtime errors are explicit; the library does not install software. For an offline workstation, an administrator must deploy the x64 Evergreen standalone installer before running ImageAssist; the NuGet SDK and WebView2Loader.dll are not the browser runtime. Deploy Microsoft Visual C++ 2015–2022 Redistributable (x64) for the native Rust/MSVC engine and loader dependencies. Keep the existing ImageAssist native/Skia dependencies. No installer is downloaded or launched by this library. Its default profile is `%LOCALAPPDATA%/SparrowStudio/WebView2`, never the EXE directory; set UserDataFolder before showing to select another writable path.

All session creation, start and polling run off the UI thread. A UI timer updates elapsed time independently of incoming native events. Close requests cancel and keep the message loop alive until the sole RunAsync consumer completes. Direct Dispose during a solve is deferred until cancellation and native session disposal finish; callers must keep the WinForms message loop alive rather than terminate the process. Repeated Dispose after completion is safe.

## Security and ownership

HTML, CSS and JS are embedded resources assembled into one NavigateToString document below 2 MB. There are no external fonts, scripts, images or network calls. CSP denies network/frame/object/form access; host rejects resource requests, navigation, new windows, downloads and permission requests. Host objects, developer tools and browser shortcuts are disabled. Job names and labels use textContent, and geometry uses SVG DOM attributes; user data is not inserted as HTML.

Only exact one-property messages `{type: ready|start|cancel|apply|close}` are accepted from about:blank. NavigateToString may report its initial NavigationStarting URI as a data:text/html base64 document on this runtime; only the exact host-assembled document (or about:blank) is allowed once. Every later navigation and all frame navigation are denied. The committed page and message source remain about:blank. Result payloads from JavaScript are never read. Start is single-use, and apply is enabled only after native completion, no cancellation or host error, exact placement coverage and independent NestingSolver.Validate. CopyIndex is local to each board: coverage is checked against each SheetResult.Job, then per-Part quantities are summed against the original Job. Dispose the dialog after ShowDialog returns. Native session lifetime is held until RunAsync completes.

## ImageAssist

SparrowNestProgressDialog subclasses this preview. MainForm1 passes sparrow.Job and, only after Apply/OK, runs another independent Validate and SparrowNestOpt.AcceptResult. The existing Operation.Execute/Undo and coordinate mapping remain unchanged. The legacy NestOpt path and native algorithm are not modified.

## Tests

The sibling winforms-smoke executable drives the real WebView2 page in an STA WinForms message loop. It checks readiness, solve snapshots, apply/cancel state and offline resource bounds. This is programmatic smoke coverage, not a claim of manual UI testing.
