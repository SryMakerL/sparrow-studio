using System;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using SparrowStudio.Core;
using SparrowStudio.WinForms;

internal static class Program
{
    private static readonly BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
    [STAThread] private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        try
        {
            var read = typeof(NestingPreviewDialog).GetMethod("ReadPage", BindingFlags.Static | BindingFlags.NonPublic);
            string page = (string)read.Invoke(null, null);
            Check(System.Text.Encoding.UTF8.GetByteCount(page) < 2000000 && !page.Contains("innerHTML"), "embedded self-contained resource boundary");
            BudgetContracts();
            if (args.Contains("--contracts-only")) { Console.WriteLine("PASS managed budget contracts only; native/WebView2 not exercised"); return 0; }
            Run("budget"); Run("apply"); Run("stop"); Run("stopcancel"); Run("stopclose"); Run("stoppartial"); Run("cancel"); Run("close"); Run("dispose");
            Console.WriteLine("PASS all WebView2/native preview smoke scenarios"); return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
    private static string Json(object value) => Newtonsoft.Json.JsonConvert.SerializeObject(value, SparrowJson.CreateSettings());
    private static Newtonsoft.Json.Linq.JObject Budget() => Newtonsoft.Json.Linq.JObject.Parse("{\"timeLimitSeconds\":10,\"sheetInitialSearchSeconds\":0.2,\"sheetInsertionWarmStartSeconds\":2,\"sheetCompressionSeconds\":2,\"sheetInsertionFailures\":1}");
    private static void BudgetContracts()
    {
        using (var dialog = new NestingPreviewDialog(Job(30)))
        {
            var receive = typeof(NestingPreviewDialog).GetMethod("ReceiveMessage", Flags);
            typeof(NestingPreviewDialog).GetField("ready", Flags).SetValue(dialog, true);
            string before = Json(dialog.EffectiveJob);
            Action<string> reject = payload =>
            {
                receive.Invoke(dialog, new object[] { payload });
                Check(!(bool)typeof(NestingPreviewDialog).GetField("started", Flags).GetValue(dialog) && typeof(NestingPreviewDialog).GetField("operation", Flags).GetValue(dialog) == null && typeof(NestingPreviewDialog).GetField("cancellation", Flags).GetValue(dialog) == null && Json(dialog.EffectiveJob) == before, "invalid start rejected without session: " + payload);
            };
            reject("{\"type\":\"start\"}");
            reject("{\"type\":\"start\",\"settings\":{}}");
            foreach (var patch in new[] { "{\"unknown\":1}", "{\"sheetInitialSearchSeconds\":-1}", "{\"sheetInsertionWarmStartSeconds\":1.5}", "{\"timeLimitSeconds\":0}", "{\"timeLimitSeconds\":601}", "{\"timeLimitSeconds\":1.5}", "{\"timeLimitSeconds\":10.0}", "{\"sheetCompressionSeconds\":0}", "{\"sheetInsertionFailures\":101}", "{\"sheetInitialSearchSeconds\":601}", "{\"sheetCompressionSeconds\":\"2\"}", "{\"sheetInsertionFailures\":null}", "{\"sheetInitialSearchSeconds\":\"NaN\"}" })
            {
                var settings = Budget(); settings.Merge(Newtonsoft.Json.Linq.JObject.Parse(patch), new Newtonsoft.Json.Linq.JsonMergeSettings { MergeNullValueHandling = Newtonsoft.Json.Linq.MergeNullValueHandling.Merge });
                reject(new Newtonsoft.Json.Linq.JObject { ["type"] = "start", ["settings"] = settings }.ToString());
            }
            reject(new Newtonsoft.Json.Linq.JObject { ["type"] = "start", ["settings"] = Budget(), ["job"] = new Newtonsoft.Json.Linq.JObject() }.ToString());
            reject("{\"type\":\"start\",\"type\":\"start\",\"settings\":" + Budget().ToString() + "}");
            reject("{\"type\":\"start\",\"settings\":" + Budget().ToString().Replace("\"sheetInitialSearchSeconds\": 0.2", "\"sheetInitialSearchSeconds\": 0.2, \"sheetInitialSearchSeconds\": 0.3") + "}");
            var apply = typeof(NestingPreviewDialog).GetMethod("ApplyBudgetSettings", Flags);
            var boundary = Budget(); boundary["sheetInitialSearchSeconds"] = .1;
            Check((bool)apply.Invoke(dialog, new object[] { boundary }), "minimum initial budget accepted");
            boundary["sheetInitialSearchSeconds"] = 600; boundary["sheetInsertionWarmStartSeconds"] = 600; boundary["sheetCompressionSeconds"] = 600; boundary["sheetInsertionFailures"] = 100;
            Check((bool)apply.Invoke(dialog, new object[] { boundary }), "maximum phase budgets accepted");
            Check((bool)apply.Invoke(dialog, new object[] { Budget() }), "valid budget accepted");
            Check(dialog.EffectiveJob.Settings.TimeLimitSeconds == 10 && dialog.EffectiveJob.Settings.SheetInitialSearchSeconds == .2 && dialog.EffectiveJob.Settings.SheetInsertionWarmStartSeconds == 2 && dialog.EffectiveJob.Settings.SheetCompressionSeconds == 2, "effective budget values");
            var snapshot = dialog.EffectiveJob; snapshot.Parts[0].Outer[0][0] = 999; snapshot.Settings.TimeLimitSeconds = 600;
            Check(dialog.EffectiveJob.Parts[0].Outer[0][0] == -30 && dialog.EffectiveJob.Settings.TimeLimitSeconds == 10, "EffectiveJob returns deep clone");
            foreach (int seconds in new[] { 1, 13, 47, 600 })
            {
                var custom = Budget(); custom["timeLimitSeconds"] = seconds;
                Check((bool)apply.Invoke(dialog, new object[] { custom }) && dialog.EffectiveJob.Settings.TimeLimitSeconds == seconds, "custom total seconds accepted: " + seconds);
            }
            var auto = Budget(); auto["timeLimitSeconds"] = Newtonsoft.Json.Linq.JValue.CreateNull();
            Check((bool)apply.Invoke(dialog, new object[] { auto }) && dialog.EffectiveJob.Settings.TimeLimitSeconds == null, "automatic budget retains null deadline");
        }
    }
    private static void Check(bool condition, string name) { if (!condition) throw new Exception("FAIL " + name); Console.WriteLine("PASS " + name); }
    private static Job Job(int seconds) => new Job { Name = "Smoke <script>not markup</script>", Parts = new[] { new Part { Id = "a", Quantity = 4, Outer = new[] { new[] { -30d, -30d }, new[] { 30d, -30d }, new[] { 30d, 30d }, new[] { -30d, 30d } } } }, Settings = new JobSettings { MaterialWidthMm = 100, SheetLengthMm = 100, SheetCount = 4, TimeLimitSeconds = seconds, SheetCompressionSeconds = 1, SheetInsertionWarmStartSeconds = 1, SheetInsertionFailures = 1 } };
    private static void Run(string mode)
    {
        using (var dialog = new NestingPreviewDialog(Job(mode == "apply" ? 10 : 30)))
        {
            Exception failure = null; bool snapshots = false;
            dialog.Shown += async (sender, args) =>
            {
                try
                {
                    var browser = (WebView2)typeof(NestingPreviewDialog).GetField("browser", Flags).GetValue(dialog);
                    var ready = typeof(NestingPreviewDialog).GetField("ready", Flags);
                    browser.CoreWebView2InitializationCompleted += (s, e) =>
                    {
                        if (!e.IsSuccess) return;
                        browser.CoreWebView2.NavigationStarting += (a, n) => Console.WriteLine("NAV " + n.Uri.Split(':')[0] + " cancelled=" + n.Cancel);
                        browser.CoreWebView2.NavigationCompleted += (a, n) => Console.WriteLine("NAV DONE " + n.IsSuccess + " " + n.WebErrorStatus);
                        browser.CoreWebView2.WebResourceRequested += (a, n) => Console.WriteLine("RESOURCE " + n.Request.Uri + " " + n.ResourceContext);
                    };
                    for (int i = 0; !(bool)ready.GetValue(dialog) && i < 400; i++) await Task.Delay(50);
                    if (dialog.Error != null) throw dialog.Error;
                    if (!(bool)ready.GetValue(dialog) && browser.CoreWebView2 != null) Console.WriteLine("DIAG " + browser.Source + " " + await browser.ExecuteScriptAsync("JSON.stringify({url:location.href,text:document.body.innerText,chrome:!!window.chrome.webview})"));
                    Check((bool)ready.GetValue(dialog), mode + " WebView2 initialized/page ready");
                    bool remoteBlocked = false;
                    browser.CoreWebView2.NavigationStarting += (s, e) => { if (e.Uri.StartsWith("https://")) remoteBlocked = e.Cancel; };
                    await browser.ExecuteScriptAsync("fetch('https://example.invalid/').then(()=>window.__network=false).catch(()=>window.__network=true);location.href='https://example.invalid/';");
                    await Task.Delay(100);
                    Check(remoteBlocked && await browser.ExecuteScriptAsync("location.href==='about:blank' && window.__network===true") == "true", "remote navigation and network denied");
                    await browser.ExecuteScriptAsync("window.__snapshots=0;window.__events=[];window.__sequence=0;window.chrome.webview.addEventListener('message',e=>{if(e.data.type==='snapshot'){window.__snapshots++;window.__events.push(...(e.data.eventTypes||[]));window.__sequence=Math.max(window.__sequence,e.data.sequence||0);}});");
                    await browser.ExecuteScriptAsync("window.chrome.webview.postMessage({type:'apply',result:{reason:'Complete'}});window.chrome.webview.postMessage({type:'unknown'});");
                    Check(dialog.Result == null, mode + " rejects forged/early apply");
                    Check(await browser.ExecuteScriptAsync("document.getElementById('stop').disabled") == "true", mode + " stop disabled without current");
                    await browser.ExecuteScriptAsync("window.chrome.webview.postMessage({type:'stop'});");
                    await Task.Delay(50);
                    Check(!(bool)typeof(NestingPreviewDialog).GetField("stopRequested", Flags).GetValue(dialog), mode + " host rejects stop without current");
                    if (mode == "budget") await browser.ExecuteScriptAsync("document.getElementById('totalSeconds').value='17';document.getElementById('initialSeconds').value='0.2';document.getElementById('insertionSeconds').value='2';document.getElementById('compressionSeconds').value='2';");
                    else Check(await browser.ExecuteScriptAsync("document.getElementById('initialSeconds').value==='2.5' && document.getElementById('insertionSeconds').value==='1' && document.getElementById('compressionSeconds').value==='1' && document.getElementById('insertionFailures').value==='1'") == "true", mode + " unchanged default budgets");
                    await browser.ExecuteScriptAsync("document.getElementById('start').click()");
                    for (int i = 0; !(bool)typeof(NestingPreviewDialog).GetField("started", Flags).GetValue(dialog) && i < 100; i++) await Task.Delay(20);
                    Check(await browser.ExecuteScriptAsync("[...document.querySelectorAll('#budgetSettings input,#budgetSettings select')].every(n=>n.disabled)") == "true", mode + " budget controls locked while running");
                    if (mode == "budget")
                    {
                        var settings = Newtonsoft.Json.Linq.JObject.Parse(Json(dialog.EffectiveJob))["settings"];
                        Check((int)settings["timeLimitSeconds"] == 17 && (double)settings["sheetInitialSearchSeconds"] == .2 && (int)settings["sheetInsertionWarmStartSeconds"] == 2 && (int)settings["sheetCompressionSeconds"] == 2 && (int)settings["sheetInsertionFailures"] == 1, "host effective camelCase serialized budgets");
                        string locked = Json(dialog.EffectiveJob);
                        await browser.ExecuteScriptAsync("window.chrome.webview.postMessage({type:'start',settings:{timeLimitSeconds:600,sheetInitialSearchSeconds:600,sheetInsertionWarmStartSeconds:600,sheetCompressionSeconds:600,sheetInsertionFailures:100}})");
                        await Task.Delay(50); Check(Json(dialog.EffectiveJob) == locked, "second start cannot change active settings");
                    }
                    if (mode == "apply" || mode == "budget")
                    {
                        for (int i = 0; !(bool)typeof(NestingPreviewDialog).GetField("canApply", Flags).GetValue(dialog) && dialog.Error == null && i < 600; i++) await Task.Delay(50);
                        if (dialog.Error != null)
                        {
                            var rejected = (Result)typeof(NestingPreviewDialog).GetField("candidate", Flags).GetValue(dialog);
                            Console.WriteLine("REJECTED " + Newtonsoft.Json.JsonConvert.SerializeObject(rejected, SparrowJson.CreateSettings()));
                            if (rejected != null) Console.WriteLine("VALIDATION " + Newtonsoft.Json.JsonConvert.SerializeObject(new NestingSolver().Validate(dialog.EffectiveJob, rejected), SparrowJson.CreateSettings()));
                            Console.WriteLine("HOST ERROR " + dialog.Error);
                            throw dialog.Error;
                        }
                        Check((bool)typeof(NestingPreviewDialog).GetField("canApply", Flags).GetValue(dialog), "complete independently validated result enables apply");
                        snapshots = await browser.ExecuteScriptAsync("window.__snapshots>0") == "true";
                        Check(await browser.ExecuteScriptAsync("window.__sequence>0 && window.__events.includes('candidate') && window.__events.includes('finished')") == "true", "actual native candidate/finished events and sequence");
                        Console.WriteLine("NATIVE EVENTS " + await browser.ExecuteScriptAsync("JSON.stringify([...new Set(window.__events)])"));
                        Check(await browser.ExecuteScriptAsync("document.querySelectorAll('#canvas path').length===4 && document.getElementById('sheets').textContent==='4' && document.getElementById('parts').textContent==='4 / 0'") == "true", "SVG placements and remaining count");
                        Check(await browser.ExecuteScriptAsync("(()=>{const c=document.getElementById('canvas'),v=c.getAttribute('viewBox');document.getElementById('plus').click();return v!==c.getAttribute('viewBox')})()") == "true", "SVG zoom changes viewBox");
                        Check(await browser.ExecuteScriptAsync("document.getElementById('jobName').textContent.includes('<script>')") == "true", "user job label rendered as text");
                        var saved = (Result)typeof(NestingPreviewDialog).GetField("candidate", Flags).GetValue(dialog);
                        if (mode == "budget") Check(saved.Sheets.All(s => s.Job.Settings.TimeLimitSeconds == 17 && s.Job.Settings.SheetInitialSearchSeconds == .2 && s.Job.Settings.SheetInsertionWarmStartSeconds == 2 && s.Job.Settings.SheetCompressionSeconds == 2 && s.Job.Settings.SheetInsertionFailures == 1), "native child settings reflect edited budgets on every board");
                        Check(await browser.ExecuteScriptAsync("document.getElementById('budgetSettings').disabled && [...document.querySelectorAll('#budgetSettings input,#budgetSettings select')].every(n=>n.disabled)") == "true", mode + " controls remain locked after completion");
                        var complete = typeof(NestingPreviewDialog).GetMethod("Complete", BindingFlags.Static | BindingFlags.NonPublic);
                        Check(!(bool)complete.Invoke(null, new object[] { Job(10), saved, new Validation { Status = "failed" } }), "failed independent validation rejects apply");
                        var missing = saved.Sheets[0].Result.Placements;
                        saved.Sheets[0].Result.Placements = new Placement[0];
                        Check(!(bool)complete.Invoke(null, new object[] { Job(10), saved, new Validation { Status = "passed" } }), "missing placement rejects complete coverage");
                        saved.Sheets[0].Result.Placements = missing;
                        await browser.ExecuteScriptAsync("document.getElementById('current').click();document.getElementById('fit').click();");
                        Check(await browser.ExecuteScriptAsync("document.getElementById('current').classList.contains('selected') && document.querySelectorAll('#canvas path').length>0") == "true", "actual current round remains viewable");
                        await browser.ExecuteScriptAsync("document.getElementById('apply').click()");
                    }
                    else if (mode.StartsWith("stop"))
                    {
                        var currentField = typeof(NestingPreviewDialog).GetField("currentRound", Flags);
                        var covered = typeof(NestingPreviewDialog).GetMethod("Covered", BindingFlags.Static | BindingFlags.NonPublic);
                        var snapshotMethod = typeof(NestingPreviewDialog).GetMethod("Snapshot", Flags);
                        Result current = null;
                        var elapsed = System.Diagnostics.Stopwatch.StartNew();
                        for (int i = 0; i < 500; i++)
                        {
                            current = (Result)currentField.GetValue(dialog);
                            if (i % 50 == 0) Console.WriteLine("WAIT CURRENT " + mode + " " + elapsed.Elapsed.TotalSeconds.ToString("F1") + "s boards=" + (current?.Sheets?.Length ?? 0));
                            if (current != null && (bool)covered.Invoke(null, new object[] { Job(30), current, new NestingSolver().Validate(Job(30), current) })) break;
                            if (dialog.Error != null) throw dialog.Error;
                            await Task.Delay(40);
                        }
                        Check(current != null && (bool)covered.Invoke(null, new object[] { Job(30), current, new NestingSolver().Validate(Job(30), current) }), mode + " complete real native current before deadline");
                        string selected = Newtonsoft.Json.JsonConvert.SerializeObject(current, SparrowJson.CreateSettings());
                        var different = Newtonsoft.Json.JsonConvert.DeserializeObject<Result>(selected, SparrowJson.CreateSettings());
                        different.Sheets[0].Result.Placements[0].XMm += 1;
                        snapshotMethod.Invoke(dialog, new object[] { new SessionSnapshot { Best = different, Events = new[] { new Newtonsoft.Json.Linq.JObject { ["type"] = "candidate", ["result"] = Newtonsoft.Json.Linq.JObject.FromObject(different, Newtonsoft.Json.JsonSerializer.Create(SparrowJson.CreateSettings())) } } } });
                        Check(Newtonsoft.Json.JsonConvert.SerializeObject(currentField.GetValue(dialog), SparrowJson.CreateSettings()) == selected, "candidate differing from current cannot overwrite true current");
                        if (mode == "stoppartial")
                        {
                            var partial = Newtonsoft.Json.JsonConvert.DeserializeObject<Result>(selected, SparrowJson.CreateSettings());
                            partial.Sheets = partial.Sheets.Take(partial.Sheets.Length - 1).ToArray();
                            snapshotMethod.Invoke(dialog, new object[] { new SessionSnapshot { Events = new[] { new Newtonsoft.Json.Linq.JObject { ["type"] = "current-round", ["result"] = Newtonsoft.Json.Linq.JObject.FromObject(partial, Newtonsoft.Json.JsonSerializer.Create(SparrowJson.CreateSettings())) } } } });
                            selected = Newtonsoft.Json.JsonConvert.SerializeObject(partial, SparrowJson.CreateSettings());
                        }
                        await browser.ExecuteScriptAsync("document.getElementById('stop').click()");
                        for (int i = 0; !(bool)typeof(NestingPreviewDialog).GetField("stopRequested", Flags).GetValue(dialog) && i < 100; i++) await Task.Delay(10);
                        var frozen = (Result)typeof(NestingPreviewDialog).GetField("frozenCurrent", Flags).GetValue(dialog);
                        Check(frozen != null && Newtonsoft.Json.JsonConvert.SerializeObject(frozen, SparrowJson.CreateSettings()) == selected, mode + " click freezes exact current not best");
                        Check(!ReferenceEquals(frozen, currentField.GetValue(dialog)), "freeze is deep clone");
                        snapshotMethod.Invoke(dialog, new object[] { new SessionSnapshot { Best = different, Events = new[] { new Newtonsoft.Json.Linq.JObject { ["type"] = "current-round", ["result"] = Newtonsoft.Json.Linq.JObject.FromObject(different, Newtonsoft.Json.JsonSerializer.Create(SparrowJson.CreateSettings())) } } } });
                        Check(Newtonsoft.Json.JsonConvert.SerializeObject(frozen, SparrowJson.CreateSettings()) == selected, "late snapshots cannot change frozen selection");
                        if (mode == "stopcancel") await browser.ExecuteScriptAsync("window.chrome.webview.postMessage({type:'cancel'});");
                        if (mode == "stopclose") { dialog.Close(); return; }
                        for (int i = 0; (bool)typeof(NestingPreviewDialog).GetField("running", Flags).GetValue(dialog) && i < 400; i++) await Task.Delay(25);
                        Check(!(bool)typeof(NestingPreviewDialog).GetField("running", Flags).GetValue(dialog), mode + " awaits native safe exit");
                        Check(elapsed.Elapsed.TotalSeconds < 30, mode + " finishes before original 30 second budget");
                        bool applicable = (bool)typeof(NestingPreviewDialog).GetField("canApply", Flags).GetValue(dialog);
                        if (mode == "stop")
                        {
                            Check(applicable && dialog.StoppedByUser && dialog.Result == null, "stop permits inspection but never auto applies");
                            var chosen = (Result)typeof(NestingPreviewDialog).GetField("candidate", Flags).GetValue(dialog);
                            var expected = Newtonsoft.Json.JsonConvert.DeserializeObject<Result>(selected, SparrowJson.CreateSettings()); expected.Reason = "UserStopped";
                            Check(!chosen.Cancelled && Newtonsoft.Json.JsonConvert.SerializeObject(chosen, SparrowJson.CreateSettings()) == Newtonsoft.Json.JsonConvert.SerializeObject(expected, SparrowJson.CreateSettings()), "stopped final result exactly frozen current except explicit reason");
                            await Task.Delay(100);
                            Check(await browser.ExecuteScriptAsync("document.getElementById('current').classList.contains('selected') && document.getElementById('apply').textContent==='应用当前轮结果'") == "true", "stopped UI selects frozen current");
                            await browser.ExecuteScriptAsync("document.getElementById('apply').click()");
                        }
                        else
                        {
                            Check(!applicable, mode + " cannot apply incomplete or discarded snapshot");
                            if (mode == "stoppartial") Check(dialog.StoppedByUser, "partial freeze remains inspectable");
                            else Check(!dialog.StoppedByUser, "cancel overrides stop selection");
                            await browser.ExecuteScriptAsync("window.chrome.webview.postMessage({type:'apply'});"); await Task.Delay(100);
                            Check(dialog.Result == null, mode + " forged apply cannot bypass host coverage"); dialog.Close();
                        }
                    }
                    else
                    {
                        for (int i = 0; !(bool)typeof(NestingPreviewDialog).GetField("running", Flags).GetValue(dialog) && i < 100; i++) await Task.Delay(20);
                        Check((bool)typeof(NestingPreviewDialog).GetField("running", Flags).GetValue(dialog), mode + " native operation started");
                        await Task.Delay(150);
                        if (mode == "dispose")
                        {
                            dialog.Dispose();
                            Check(!dialog.IsDisposed, "active Dispose defers resource release");
                            for (int i = 0; !dialog.IsDisposed && i < 600; i++) await Task.Delay(50);
                            Check(dialog.IsDisposed, "deferred Dispose completes after native exit");
                            return;
                        }
                        if (mode == "cancel")
                        {
                            await browser.ExecuteScriptAsync("document.getElementById('cancel').click()");
                            for (int i = 0; (bool)typeof(NestingPreviewDialog).GetField("running", Flags).GetValue(dialog) && i < 400; i++) await Task.Delay(50);
                            Check(!(bool)typeof(NestingPreviewDialog).GetField("running", Flags).GetValue(dialog), "cancel awaits native exit");
                            Check(!(bool)typeof(NestingPreviewDialog).GetField("canApply", Flags).GetValue(dialog), "cancel disables apply");
                            await browser.ExecuteScriptAsync("window.chrome.webview.postMessage({type:'apply'});");
                            await Task.Delay(100);
                            Check(dialog.Result == null, "host rejects apply after cancellation");
                        }
                        dialog.Close();
                    }
                }
                catch (Exception error) { failure = error; dialog.Close(); }
            };
            var outcome = dialog.ShowDialog();
            if (failure != null) throw failure;
            if (mode == "apply" || mode == "budget") { Check(outcome == DialogResult.OK && dialog.Result != null, "apply alone returns host result / OK"); Check(snapshots, "real native solve snapshots reached WebView2"); }
            else if (mode == "stop") Check(outcome == DialogResult.OK && dialog.Result != null && dialog.Result.Reason == "UserStopped" && !dialog.Result.Cancelled && dialog.StoppedByUser && dialog.ResultSelection == "CurrentRound", "explicit apply returns authorized UserStopped result");
            else Check(outcome != DialogResult.OK && dialog.Result == null, mode + " never applies result");
            Check(!(bool)typeof(NestingPreviewDialog).GetField("running", Flags).GetValue(dialog), mode + " closes after native exit");
        }
    }
}
