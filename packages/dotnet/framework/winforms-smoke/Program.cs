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
    [STAThread] private static int Main()
    {
        Application.EnableVisualStyles();
        try
        {
            var read = typeof(NestingPreviewDialog).GetMethod("ReadPage", BindingFlags.Static | BindingFlags.NonPublic);
            string page = (string)read.Invoke(null, null);
            Check(System.Text.Encoding.UTF8.GetByteCount(page) < 2000000 && !page.Contains("innerHTML"), "embedded self-contained resource boundary");
            Run("apply"); Run("cancel"); Run("close"); Run("dispose");
            Console.WriteLine("PASS all WebView2/native preview smoke scenarios"); return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
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
                    await browser.ExecuteScriptAsync("document.getElementById('start').click()");
                    if (mode == "apply")
                    {
                        for (int i = 0; !(bool)typeof(NestingPreviewDialog).GetField("canApply", Flags).GetValue(dialog) && dialog.Error == null && i < 600; i++) await Task.Delay(50);
                        if (dialog.Error != null)
                        {
                            var rejected = (Result)typeof(NestingPreviewDialog).GetField("candidate", Flags).GetValue(dialog);
                            Console.WriteLine("REJECTED " + Newtonsoft.Json.JsonConvert.SerializeObject(rejected, SparrowJson.CreateSettings()));
                            Console.WriteLine("VALIDATION " + Newtonsoft.Json.JsonConvert.SerializeObject(new NestingSolver().Validate(Job(10), rejected), SparrowJson.CreateSettings()));
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
            if (mode == "apply") { Check(outcome == DialogResult.OK && dialog.Result != null, "apply alone returns host result / OK"); Check(snapshots, "real native solve snapshots reached WebView2"); }
            else Check(outcome != DialogResult.OK && dialog.Result == null, mode + " never applies result");
            Check(!(bool)typeof(NestingPreviewDialog).GetField("running", Flags).GetValue(dialog), mode + " closes after native exit");
        }
    }
}
