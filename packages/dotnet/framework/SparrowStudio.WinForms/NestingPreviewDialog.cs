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
        private Result candidate, currentRound, frozenCurrent;
        private bool hasCurrentRound, stopRequested, discardRequested, nativeFinished;
        public bool StoppedByUser { get; private set; }
        public string ResultSelection { get; private set; }
        private bool ready, started, running, closePending, allowClose, canApply, initialNavigation, disposePending;
        private string initialDocument;
        private readonly System.Windows.Forms.Timer heartbeat = new System.Windows.Forms.Timer { Interval = 200 };
        private string phase = "等待开始";
        private readonly System.Diagnostics.Stopwatch clock = new System.Diagnostics.Stopwatch();
        public Result Result { get; private set; }
        public Exception Error { get; private set; }
        public Job EffectiveJob => CloneJob(job);
        private static Job CloneJob(Job value) => JsonConvert.DeserializeObject<Job>(JsonConvert.SerializeObject(value, SparrowJson.CreateSettings()), SparrowJson.CreateSettings());
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
            ReceiveMessage(args.WebMessageAsJson);
        }
        private void ReceiveMessage(string json)
        {
            JObject message;
            try { message = JObject.Parse(json, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error }); } catch (JsonException) { return; }
            if (message["type"]?.Type != JTokenType.String) return;
            string command = (string)message["type"];
            if (command == "start")
            {
                if (!ready || started || Error != null || message.Count != 2 || !(message["settings"] is JObject settings)) return;
                if (!ApplyBudgetSettings(settings)) return;
                started = true; running = true; cancellation = new CancellationTokenSource(); operation = RunAsync();
                return;
            }
            if (message.Count != 1) return;
            switch (command)
            {
                case "ready": if (!ready) { ready = true; Send(new { type = "job", job }); Publish(); } break;
                case "stop": StopCurrent(); break;
                case "cancel": Cancel(); break;
                case "apply": if (canApply && Error == null && !running && candidate != null && !closePending && !discardRequested && (StoppedByUser || !cancellation.IsCancellationRequested)) { Result = Clone(candidate); ResultSelection = StoppedByUser ? "CurrentRound" : "Best"; allowClose = true; DialogResult = DialogResult.OK; Close(); } break;
                case "close": Close(); break;
            }
        }
        private bool ApplyBudgetSettings(JObject settings)
        {
            string[] fields = { "timeLimitSeconds", "sheetInitialSearchSeconds", "sheetInsertionWarmStartSeconds", "sheetCompressionSeconds", "sheetInsertionFailures" };
            if (settings.Count != fields.Length || settings.Properties().Any(p => !fields.Contains(p.Name))) return false;
            var total = settings[fields[0]];
            if (total.Type != JTokenType.Null && (total.Type != JTokenType.Integer || !FiniteInRange(total, 1, 600))) return false;
            var initial = settings[fields[1]];
            if ((initial.Type != JTokenType.Float && initial.Type != JTokenType.Integer) || !FiniteInRange(initial, .1, 600)) return false;
            for (int i = 2; i < fields.Length; i++)
                if (settings[fields[i]].Type != JTokenType.Integer || !FiniteInRange(settings[fields[i]], 1, i == 4 ? 100 : 600)) return false;
            job.Settings.TimeLimitSeconds = total.Type == JTokenType.Null ? (int?)null : (int)total;
            job.Settings.SheetInitialSearchSeconds = (double)initial;
            job.Settings.SheetInsertionWarmStartSeconds = (int)settings[fields[2]];
            job.Settings.SheetCompressionSeconds = (int)settings[fields[3]];
            job.Settings.SheetInsertionFailures = (int)settings[fields[4]];
            return true;
        }
        private static bool FiniteInRange(JToken token, double min, double max)
        {
            double value = (double)token;
            return !double.IsNaN(value) && !double.IsInfinity(value) && value >= min && value <= max;
        }
        private async Task RunAsync()
        {
            clock.Start(); phase = "启动原生求解"; Publish();
            try
            {
                Result completed = null;
                try
                {
                    completed = await Task.Run(async () =>
                    {
                        using (var session = new NestingSession(job))
                        {
                            var progress = new InlineProgress(snapshot => OnUi(() => Snapshot(snapshot)));
                            return await session.RunAsync(progress, cancellation.Token).ConfigureAwait(false);
                        }
                    });
                }
                catch (OperationCanceledException) when (stopRequested && !discardRequested) { }
                nativeFinished = true;
                if (stopRequested && !discardRequested && frozenCurrent != null && Error == null)
                {
                    phase = "正在截止 · 原生已退出，独立校验冻结快照"; Publish();
                    var stoppedSnapshot = frozenCurrent;
                    var frozenValidation = await Task.Run(() => new NestingSolver().Validate(job, stoppedSnapshot));
                    if (discardRequested || closePending || Error != null) { candidate = null; phase = "已取消 · 未应用"; return; }
                    int missing = Math.Max(0, job.Parts.Sum(p => p.Quantity) - PlacedCount(frozenCurrent));
                    canApply = Covered(job, frozenCurrent, frozenValidation);
                    StoppedByUser = true;
                    if (canApply)
                    {
                        candidate = Clone(frozenCurrent);
                        candidate.Reason = "UserStopped";
                        phase = "已截止待应用 · 用户截止";
                    }
                    else { candidate = null; phase = "截止快照未完整不可应用 · 缺件 " + missing + " 件（或几何校验未通过）"; }
                    Send(new { type = "snapshot", current = frozenCurrent, stopped = true });
                    return;
                }
                candidate = completed;
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
            return result != null && string.Equals(result.Reason, "Complete", StringComparison.OrdinalIgnoreCase) && Covered(job, result, validation);
        }
        internal static bool Covered(Job job, Result result, Validation validation)
        {
            if (result == null || result.Cancelled || validation == null || validation.Status != "passed" || result.Validation == null || result.Validation.Status != "passed" || result.Unplaced == null || result.Unplaced.Length != 0) return false;
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
            if (!running || IsDisposed || stopRequested || discardRequested) return;
            foreach (var item in snapshot.Events ?? new JObject[0])
            {
                if (item["phase"] != null) phase = (string)item["phase"];
                string type = (string)item["type"];
                var value = item["result"];
                if (type == "current-round" && value != null && value.Type != JTokenType.Null)
                { currentRound = value.ToObject<Result>(JsonSerializer.Create(SparrowJson.CreateSettings())); hasCurrentRound = true; }
                else if (type == "candidate" && !hasCurrentRound && job.Settings.SheetCount == 1 && value != null && value.Type != JTokenType.Null)
                    currentRound = value.ToObject<Result>(JsonSerializer.Create(SparrowJson.CreateSettings()));
            }
            Send(new { type = "snapshot", best = snapshot.Best, current = currentRound, sequence = snapshot.Sequence, eventTypes = (snapshot.Events ?? new JObject[0]).Select(e => (string)e["type"]).ToArray() }); Publish();
        }
        private static Result Clone(Result value) => JsonConvert.DeserializeObject<Result>(JsonConvert.SerializeObject(value, SparrowJson.CreateSettings()), SparrowJson.CreateSettings());
        private static int PlacedCount(Result value) => value.Sheets != null ? value.Sheets.Sum(s => s?.Result?.Placements?.Length ?? 0) : value.Placements?.Length ?? 0;
        private void StopCurrent()
        {
            if (!running || nativeFinished || stopRequested || discardRequested || closePending || currentRound == null || Error != null) return;
            frozenCurrent = Clone(currentRound); stopRequested = true; canApply = false;
            phase = "正在截止 · 保留当前轮，等待原生会话安全退出…";
            Send(new { type = "snapshot", current = frozenCurrent, stopped = true });
            cancellation.Cancel(); Publish();
        }
        private void Cancel()
        {
            discardRequested = true; stopRequested = false; frozenCurrent = null; candidate = null; Result = null; StoppedByUser = false; ResultSelection = null; canApply = false;
            if (running && cancellation != null) { cancellation.Cancel(); phase = "正在取消，等待原生会话安全退出…"; }
            else phase = "已取消 · 未应用";
            Publish();
        }
        private void ClosingPreview(object sender, FormClosingEventArgs args)
        {
            if (allowClose) return;
            Result = null; canApply = false;
            if (running) { args.Cancel = true; closePending = true; Cancel(); } else { Cancel(); allowClose = true; DialogResult = DialogResult.Cancel; }
        }
        private void Fail(Exception error)
        {
            Error = error; canApply = false; phase = "失败 · 未应用";
            if (running) Cancel();
            if (ready) { Send(new { type = "error", message = error.Message }); Publish(); }
            else { fallback.Text = "Sparrow Studio 无法初始化\r\n\r\n" + error.Message + "\r\n\r\n请关闭此窗口。"; fallback.Visible = true; fallback.BringToFront(); }
        }
        private void Publish() { Send(new { type = "state", running, started, stopping = stopRequested && running, stopped = StoppedByUser, canStop = running && !nativeFinished && currentRound != null && !stopRequested && !discardRequested && !closePending && Error == null, canApply = canApply && !closePending && !discardRequested, phase, elapsed = clock.Elapsed.TotalSeconds, budget = job.Settings.TimeLimitSeconds }); }
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
