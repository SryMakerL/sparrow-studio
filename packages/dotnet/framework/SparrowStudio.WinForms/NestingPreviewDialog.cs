using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SparrowStudio.Core;

namespace SparrowStudio.WinForms
{
    public class NestingPreviewDialog : Form
    {
        private readonly Job job;
        private readonly WebView2 browser = new WebView2();
        private readonly Label fallback = new Label();
        private CancellationTokenSource cancellation;
        private Task operation;
        private Result candidate;
        private bool ready, started, running, closePending, allowClose, canApply, initialNavigation, disposePending;
        private string initialDocument;
        private readonly System.Windows.Forms.Timer heartbeat = new System.Windows.Forms.Timer { Interval = 200 };
        private string phase = "等待开始";
        private readonly System.Diagnostics.Stopwatch clock = new System.Diagnostics.Stopwatch();
        public Result Result { get; private set; }
        public Exception Error { get; private set; }
        public string UserDataFolder { get; set; }
        public NestingPreviewDialog(Job job)
        {
            if (job == null) throw new ArgumentNullException(nameof(job));
            this.job = JsonConvert.DeserializeObject<Job>(JsonConvert.SerializeObject(job, SparrowJson.CreateSettings()), SparrowJson.CreateSettings());
            Text = "Sparrow Studio · 排版预览"; ClientSize = new Size(1180, 760); MinimumSize = new Size(850, 560);
            StartPosition = FormStartPosition.CenterParent; ShowInTaskbar = false;
            UserDataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SparrowStudio", "WebView2");
            browser.Dock = DockStyle.Fill; fallback.Dock = DockStyle.Fill; fallback.Padding = new Padding(30); fallback.Text = "正在初始化 Sparrow Studio…";
            Controls.Add(browser); Controls.Add(fallback); Shown += Initialize; FormClosing += ClosingPreview;
        }
        internal static string ReadPage()
        {
            var assembly = typeof(NestingPreviewDialog).Assembly;
            Func<string, string> read = name => { using (var stream = assembly.GetManifestResourceStream("SparrowStudio.WinForms.Web." + name)) using (var reader = new StreamReader(stream, Encoding.UTF8)) return reader.ReadToEnd(); };
            string html = read("preview.html").Replace("/*STYLE*/", read("preview.css")).Replace("/*SCRIPT*/", read("preview.js"));
            if (Encoding.UTF8.GetByteCount(html) >= 2000000) throw new InvalidOperationException("预览页面超过 NavigateToString 大小限制。");
            return html;
        }
        private async void Initialize(object sender, EventArgs args)
        {
            try
            {
                if (!Environment.Is64BitProcess) throw new PlatformNotSupportedException("Sparrow Studio 需要 Windows x64 进程。");
                CoreWebView2Environment.GetAvailableBrowserVersionString();
                Directory.CreateDirectory(UserDataFolder);
                var environment = await CoreWebView2Environment.CreateAsync(null, UserDataFolder);
                if (IsDisposed) return;
                await browser.EnsureCoreWebView2Async(environment);
                if (IsDisposed) return;
                var core = browser.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false; core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false; core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreHostObjectsAllowed = false;
                core.Settings.IsWebMessageEnabled = true;
                core.NewWindowRequested += (s, e) => e.Handled = true;
                core.PermissionRequested += (s, e) => e.State = CoreWebView2PermissionState.Deny;
                core.DownloadStarting += (s, e) => e.Cancel = true;
                initialDocument = ReadPage();
                string documentUri = "data:text/html;charset=utf-8;base64," + Convert.ToBase64String(Encoding.UTF8.GetBytes(initialDocument));
                core.NavigationStarting += (s, e) =>
                {
                    if (!initialNavigation && (e.Uri == "about:blank" || e.Uri == documentUri)) initialNavigation = true;
                    else e.Cancel = true;
                };
                core.FrameNavigationStarting += (s, e) => e.Cancel = true;
                core.NavigationCompleted += (s, e) => { if (!e.IsSuccess && !ready) Fail(new InvalidOperationException("离线预览页面加载失败：" + e.WebErrorStatus)); };
                core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += (s, e) => { if (e.Request.Uri == "about:blank" && e.ResourceContext == CoreWebView2WebResourceContext.Document) return; e.Response = environment.CreateWebResourceResponse(new MemoryStream(new byte[0]), 403, "Offline preview", "Content-Type: text/plain"); };
                core.WebMessageReceived += Receive;
                core.ProcessFailed += (s, e) => Fail(new InvalidOperationException("WebView2 渲染进程已退出：" + e.ProcessFailedKind));
                core.NavigateToString(initialDocument); fallback.Visible = false;
                heartbeat.Tick += (s, e) => { if (running) Publish(); }; heartbeat.Start();
            }
            catch (WebView2RuntimeNotFoundException) { Fail(new InvalidOperationException("未找到 Microsoft Edge WebView2 Runtime。请由管理员部署 x64 Evergreen Runtime 后重试；程序不会自动安装软件。")); }
            catch (Exception error) { Fail(error); }
        }
        private void Receive(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            if (args.Source != "about:blank") return;
            string command;
            try { var message = JObject.Parse(args.WebMessageAsJson); if (message.Count != 1 || message["type"] == null || message["type"].Type != JTokenType.String) return; command = (string)message["type"]; } catch (JsonException) { return; }
            switch (command)
            {
                case "ready": if (!ready) { ready = true; Send(new { type = "job", job }); Publish(); } break;
                case "start": if (ready && !started && Error == null) { started = true; running = true; cancellation = new CancellationTokenSource(); operation = RunAsync(); } break;
                case "cancel": Cancel(); break;
                case "apply": if (canApply && Error == null && !running && candidate != null && !closePending && !cancellation.IsCancellationRequested) { Result = candidate; allowClose = true; DialogResult = DialogResult.OK; Close(); } break;
                case "close": Close(); break;
            }
        }
        private async Task RunAsync()
        {
            clock.Start(); phase = "启动原生求解"; Publish();
            try
            {
                candidate = await Task.Run(async () =>
                {
                    using (var session = new NestingSession(job))
                    {
                        var progress = new InlineProgress(snapshot => OnUi(() => Snapshot(snapshot)));
                        return await session.RunAsync(progress, cancellation.Token).ConfigureAwait(false);
                    }
                });
                cancellation.Token.ThrowIfCancellationRequested();
                phase = "独立几何校验"; Publish();
                var validation = await Task.Run(() => new NestingSolver().Validate(job, candidate));
                cancellation.Token.ThrowIfCancellationRequested();
                if (Error != null || !Complete(job, candidate, validation)) throw new InvalidOperationException("结果不完整或未通过独立几何校验，禁止应用。");
                phase = "校验通过 · 等待应用"; canApply = true;
                Send(new { type = "snapshot", best = candidate });
            }
            catch (OperationCanceledException) { candidate = null; phase = "已取消 · 未应用"; }
            catch (Exception error) { Fail(error); }
            finally
            {
                running = false; clock.Stop(); Publish();
                if (disposePending) Dispose();
                else if (closePending) { allowClose = true; DialogResult = DialogResult.Cancel; Close(); }
            }
        }
        internal static bool Complete(Job job, Result result, Validation validation)
        {
            if (result == null || result.Cancelled || !string.Equals(result.Reason, "Complete", StringComparison.OrdinalIgnoreCase) || validation == null || validation.Status != "passed" || result.Validation == null || result.Validation.Status != "passed" || result.Unplaced == null || result.Unplaced.Length != 0) return false;
            var sheets = result.Sheets ?? new[] { new SheetResult(job, result) };
            if (sheets.Length == 0) return false;
            foreach (var sheet in sheets)
            {
                if (sheet == null || sheet.Job == null || sheet.Job.Parts == null || sheet.Result == null || sheet.Result.Placements == null || sheet.Result.Cancelled || sheet.Result.Validation == null || sheet.Result.Validation.Status != "passed") return false;
                var placed = sheet.Result.Placements;
                if (placed.Any(p => p == null || double.IsNaN(p.XMm) || double.IsInfinity(p.XMm) || double.IsNaN(p.YMm) || double.IsInfinity(p.YMm) || double.IsNaN(p.AngleDeg) || double.IsInfinity(p.AngleDeg))) return false;
                var expected = sheet.Job.Parts.SelectMany(p => Enumerable.Range(0, p.Quantity).Select(i => p.Id + "/" + i)).OrderBy(x => x);
                if (!expected.SequenceEqual(placed.Select(p => p.PartId + "/" + p.CopyIndex).OrderBy(x => x))) return false;
            }
            var counts = sheets.SelectMany(s => s.Result.Placements).GroupBy(p => p.PartId).ToDictionary(g => g.Key, g => g.Count());
            return counts.Count == job.Parts.Length && job.Parts.All(p => counts.ContainsKey(p.Id) && counts[p.Id] == p.Quantity);
        }
        private void Snapshot(SessionSnapshot snapshot)
        {
            if (!running || IsDisposed) return;
            Result current = null;
            foreach (var item in snapshot.Events ?? new JObject[0])
            {
                if (item["phase"] != null) phase = (string)item["phase"];
                if ((string)item["type"] == "current-round" || (string)item["type"] == "candidate") current = item["result"]?.ToObject<Result>(JsonSerializer.Create(SparrowJson.CreateSettings()));
            }
            Send(new { type = "snapshot", best = snapshot.Best, current, sequence = snapshot.Sequence, eventTypes = (snapshot.Events ?? new JObject[0]).Select(e => (string)e["type"]).ToArray() }); Publish();
        }
        private void Cancel() { if (running && cancellation != null) { cancellation.Cancel(); canApply = false; phase = "正在取消，等待原生会话安全退出…"; Publish(); } }
        private void ClosingPreview(object sender, FormClosingEventArgs args)
        {
            if (allowClose) return;
            Result = null; canApply = false;
            if (running) { args.Cancel = true; closePending = true; Cancel(); } else { allowClose = true; DialogResult = DialogResult.Cancel; }
        }
        private void Fail(Exception error)
        {
            Error = error; canApply = false; phase = "失败 · 未应用";
            if (running) Cancel();
            if (ready) { Send(new { type = "error", message = error.Message }); Publish(); }
            else { fallback.Text = "Sparrow Studio 无法初始化\r\n\r\n" + error.Message + "\r\n\r\n请关闭此窗口。"; fallback.Visible = true; fallback.BringToFront(); }
        }
        private void Publish() { Send(new { type = "state", running, started, canApply = canApply && !closePending, phase, elapsed = clock.Elapsed.TotalSeconds, budget = job.Settings.TimeLimitSeconds }); }
        private void Send(object message) { if (ready && !IsDisposed && browser.CoreWebView2 != null) browser.CoreWebView2.PostWebMessageAsJson(JsonConvert.SerializeObject(message, SparrowJson.CreateSettings())); }
        private void OnUi(Action action) { if (IsDisposed || Disposing) return; if (InvokeRequired) { try { BeginInvoke(action); } catch (InvalidOperationException) { } } else action(); }
        protected override void Dispose(bool disposing)
        {
            if (disposing && running)
            {
                disposePending = true; closePending = true; Result = null; Cancel();
                return;
            }
            if (disposing) { heartbeat.Dispose(); if (cancellation != null) cancellation.Dispose(); browser.Dispose(); }
            base.Dispose(disposing);
        }
        private sealed class InlineProgress : IProgress<SessionSnapshot> { private readonly Action<SessionSnapshot> report; internal InlineProgress(Action<SessionSnapshot> report) { this.report = report; } public void Report(SessionSnapshot value) { report(value); } }
    }
}
