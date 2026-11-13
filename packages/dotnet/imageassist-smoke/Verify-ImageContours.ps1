param(
    [string]$AppDirectory = 'D:/work_files/2026-10-26/ImageAssist_0527_Standard_test/bin/x64/Debug',
    [string]$SamplePath = 'C:/Users/Huawei/Desktop/Nesting/CartoonBird-卡通小鸟4块.tif'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Push-Location $AppDirectory
$root=Join-Path ([IO.Path]::GetTempPath()) ('imageassist-contours-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
try {
    $env:PATH=$AppDirectory+';'+$env:PATH
    $resolver=[ResolveEventHandler]{ param($sender,$eventArgs)
        $file=Join-Path $AppDirectory (([Reflection.AssemblyName]::new($eventArgs.Name)).Name+'.dll')
        if(Test-Path -LiteralPath $file) { return [Reflection.Assembly]::LoadFrom($file) }
        return $null
    }
    [AppDomain]::CurrentDomain.add_AssemblyResolve($resolver)
    foreach($name in @('System.Runtime.CompilerServices.Unsafe.dll','System.Memory.dll','System.Buffers.dll','System.Numerics.Vectors.dll','GZMath.dll','SkiaSharp.dll','Newtonsoft.Json.dll','SparrowStudio.Core.dll','Magick.NET.Core.dll','Magick.NET-Q8-x64.dll','NetVips.dll')) {
        [void][Reflection.Assembly]::LoadFrom((Join-Path $AppDirectory $name))
    }
    $assembly=[Reflection.Assembly]::LoadFrom((Join-Path $AppDirectory 'LCImageAssist.exe'))
    $imageType=$assembly.GetType('SkiaSharpTest.ImagePaint',$true)
    $global=$assembly.GetType('SkiaSharpTest.GlobalVar',$true)
    $helper=$assembly.GetType('SkiaSharpTest.Method.NestingImageContours',$true)
    $commandType=$assembly.GetType('SkiaSharpTest.SparrowNestOpt',$true)
    $flags=[Reflection.BindingFlags]'Instance,NonPublic,Public'
    $static=[Reflection.BindingFlags]'Static,NonPublic,Public'
    if($helper.GetField('RecognitionLimit',$static).GetRawConstantValue() -ne 1200 -or $helper.GetField('SimplificationTargetMm',$static).GetRawConstantValue() -ne 0.10 -or $helper.GetField('SimplificationMaximumMm',$static).GetRawConstantValue() -ne 0.25) { throw 'High precision must retain the existing recognition configuration.' }
    $global.GetField('initialTemPath',$static).SetValue($null,$root)
    $global.GetField('displayTemPath',$static).SetValue($null,$root)
    $global.GetField('diplayDpi',$static).SetValue($null,[Drawing.Point]::new(1000,1000))
    function Assert($condition,$message) { if(-not $condition) { throw $message } }
    function Field($obj,$name) { return ,($obj.GetType().GetField($name,$flags).GetValue($obj)) }
    function Image($path) { $ctor=$imageType.GetConstructor([type[]]@([string],[double],[double],[string])); $ctor.Invoke([object[]]@([string]$path,[double]0,[double]0,'')) }
    function Recognize($image,$cut) { $helper.GetMethod('Recognize',$static).Invoke($null,[object[]]@($image.PSObject.BaseObject,[bool]$cut)) }
    $dialogType=$assembly.GetType('SkiaSharpTest.Forms.NestEngineDialog',$true)
    $dialog=[Activator]::CreateInstance($dialogType,$true)
    try {
        $recognize=Field $dialog 'recognizeContours'; $inner=Field $dialog 'cropTiff'
        $precision=Field $dialog 'contourPrecision'
        Assert ($precision.SelectedIndex -eq 0 -and -not $precision.Enabled) 'Current recognition must default to high precision.'
        $precision.SelectedIndex=1
        Assert ($dialogType.GetProperty('LowContourPrecision',$flags).GetValue($dialog,$null)) 'Low precision option must select original polygon recognition.'
        $precision.SelectedIndex=0
        Assert (-not $recognize.Checked -and -not $inner.Enabled) 'Rectangle mode must remain the default.'
        $recognize.Checked=$true; $inner.Checked=$true
        Assert ($inner.Enabled -and $precision.Enabled -and $dialogType.GetProperty('CropTiff',$flags).GetValue($dialog,$null)) 'Contour options must enable precision selection and inner cutting.'
        $recognize.Checked=$false
        Assert (-not $inner.Enabled -and -not $precision.Enabled -and -not $dialogType.GetProperty('CropTiff',$flags).GetValue($dialog,$null)) 'Precision selection and inner cutting require contour recognition.'
    } finally { $dialog.Dispose() }
    Write-Output 'PASS layout controls: safe defaults and dependent inner contour switch'
    Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
public static class ContourUiProbe {
    public static int Run(Assembly assembly) {
        var type = assembly.GetType("SkiaSharpTest.Forms.ContourRecognitionDialog", true);
        var ctor = type.GetConstructor(BindingFlags.Instance | BindingFlags.NonPublic, null, new[] { typeof(Action), typeof(string) }, null);
        int ticks = 0; int uiThread = Thread.CurrentThread.ManagedThreadId; bool workerThread = false;
        using (var form = (Form)ctor.Invoke(new object[] { (Action)(() => { workerThread = Thread.CurrentThread.ManagedThreadId != uiThread; Thread.Sleep(350); }), "UI responsiveness regression" }))
        using (var timer = new System.Windows.Forms.Timer { Interval = 25 }) {
            timer.Tick += (s,e) => ticks++; timer.Start();
            var result = form.ShowDialog();
            if (result != DialogResult.OK || !workerThread || ticks < 3) throw new Exception("Contour processing blocked UI message loop.");
        }
        return ticks;
    }
}
'@
    $ticks=[ContourUiProbe]::Run($assembly)
    Write-Output ('PASS responsive background dialog: '+$ticks+' UI timer ticks during worker task')
    $fixture=Join-Path $root 'ring.tif'
    $bitmap=[Drawing.Bitmap]::new(100,80)
    $bitmap.SetResolution(254,254)
    $graphics=[Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([Drawing.Color]::White)
        $graphics.FillRectangle([Drawing.Brushes]::Blue,10,10,80,60)
        $graphics.FillRectangle([Drawing.Brushes]::White,35,25,30,30)
        $bitmap.Save($fixture,[Drawing.Imaging.ImageFormat]::Tiff)
    } finally { $graphics.Dispose();$bitmap.Dispose() }
    $source=Image $fixture
    $tiffCount=[IO.Directory]::GetFiles($root,'*.tif',[IO.SearchOption]::AllDirectories).Length
    $solid=Recognize $source $false
    Assert ([IO.Directory]::GetFiles($root,'*.tif',[IO.SearchOption]::AllDirectories).Length -eq $tiffCount) 'Recognition without TIFF crop must not write any TIFF.'
    Assert ([object]::ReferenceEquals((Field $solid 'Image'),$source)) 'Disabled TIFF crop must retain original image instance.'
    Assert (-not (Field $solid 'RecognitionReused')) 'First recognition should compute geometry.'
    $cut=Recognize $source $true
    Assert (Field $cut 'RecognitionReused') 'Enabling TIFF crop must reuse recognized geometry.'
    $again=Recognize $source $true
    Assert (Field $again 'RecognitionReused') 'Repeated recognition must reuse cached geometry.'
    Assert (-not [object]::ReferenceEquals((Field $cut 'Image'),(Field $again 'Image'))) 'Cached TIFF must not share mutable ImagePaint instances.'
    Assert ((Field $solid 'Outer').Count -ge 4) 'Outer contour missing.'
    Assert ((Field $solid 'Holes').Count -eq 1) 'Recognition must retain inner contour even when cutting is disabled.'
    Assert (-not (Field $solid 'CropTiff') -and (Field $cut 'CropTiff')) 'Recognition and cutting must remain independent.'
    Assert ((Field $cut 'Holes').Count -eq 1) 'Expected one interior cutout.'
    Assert ((Field $solid 'Area') -eq (Field $cut 'Area')) 'TIFF crop must not change recognized material area or cut interior artwork.'
    $solidImage=Field $solid 'Image'; $cutImage=Field $cut 'Image'
    Assert ($solidImage.DisplayImage.GetPixel(50,40).Alpha -gt 200) 'Default interior must remain opaque.'
    Assert ($cutImage.DisplayImage.GetPixel(50,40).Alpha -gt 200) 'TIFF crop must preserve white interior artwork.'
    Assert ($cutImage.DisplayImage.GetPixel(0,0).Alpha -lt 20) 'Exterior background must become transparent.'
    Assert ($source.DisplayImage.GetPixel(50,40).Alpha -gt 200) 'Original image must remain unchanged.'
    $reimport=Image $fixture
    $reused=Recognize $reimport $false
    Assert (Field $reused 'RecognitionReused') 'Reimporting same file with another display path must reuse geometry.'
    $points=Field $reused 'Outer'; $originalX=$points[0][0]; $points[0][0]=999
    $safe=Recognize $source $false
    Assert ((Field $safe 'Outer')[0][0] -eq $originalX) 'Caller geometry changes must not mutate cache.'
    $reimport.Set_DPI([GZMath.GZPoint]::new(127,254))
    $rescaled=Recognize $reimport $false
    Assert (-not (Field $rescaled 'RecognitionReused')) 'Changing DPI must invalidate geometry cache.'
    $stamp=[IO.File]::GetLastWriteTimeUtc($fixture)
    try {
        [IO.File]::SetLastWriteTimeUtc($fixture,$stamp.AddSeconds(2))
        $changed=Recognize $source $false
        Assert (-not (Field $changed 'RecognitionReused')) 'Changing file version must invalidate cache.'
    } finally { [IO.File]::SetLastWriteTimeUtc($fixture,$stamp) }
    Write-Output 'PASS TIFF option and cache: no-write recognition, preserved interior, reuse, DPI/file invalidation, geometry isolation'
    $alphaPath=Join-Path $root 'alpha.png'
    $bitmap=[Drawing.Bitmap]::new(100,80)
    $bitmap.SetResolution(254,254)
    $graphics=[Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.FillRectangle([Drawing.Brushes]::White,10,10,80,60)
        $graphics.CompositingMode=[Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.FillRectangle([Drawing.Brushes]::Transparent,35,25,30,30)
        $bitmap.Save($alphaPath,[Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose();$bitmap.Dispose() }
    $alpha=Recognize (Image $alphaPath) $true
    Assert ((Field $alpha 'Outer').Count -ge 4 -and (Field $alpha 'Holes').Count -eq 1) 'Alpha mode must retain white foreground and its hole.'
    Write-Output 'PASS alpha background: white foreground and transparent hole'
    $listType=[Collections.Generic.List``1].MakeGenericType($imageType)
    $duplicate=Image $fixture
    $duplicate.Position=[GZMath.GZPoint]::new(35,45)
    $duplicates=[Activator]::CreateInstance($listType); $duplicates.Add($source); $duplicates.Add($duplicate)
    $duplicateCommand=$commandType.GetConstructors($flags)[0].Invoke([object[]]@($duplicates,[double]100,[double]100,[double]0,[double]7,[bool]$false))
    $commandType.GetMethod('RecognizeContoursWithPrecision',$flags).Invoke($duplicateCommand,[object[]]@($duplicates.PSObject.BaseObject,[bool]$false,[bool]$false))
    $duplicateResults=$commandType.GetProperty('RecognizedContours',$flags).GetValue($duplicateCommand,$null)
    Assert ((Field $duplicateResults[1] 'RecognitionReused')) 'Duplicate file should reuse first recognized geometry.'
    Assert ([object]::ReferenceEquals((Field $duplicateResults[0] 'Image'),$source) -and [object]::ReferenceEquals((Field $duplicateResults[1] 'Image'),$duplicate)) 'No-crop duplicate images must retain independent instances.'
    Assert ($duplicate.Position.x -eq 35 -and $duplicate.Position.y -eq 45) 'Recognition cache must not overwrite image position.'
    Write-Output 'PASS duplicate recognition: reused geometry and independent canvas instances'
    $canvas=[Activator]::CreateInstance($listType); $canvas.Add($source)
    $command=$commandType.GetConstructors($flags)[0].Invoke([object[]]@($canvas,[double]20,[double]20,[double]0,[double]7,[bool]$false))
    $commandType.GetMethod('RecognizeContours',$flags).Invoke($command,[object[]]@($canvas.PSObject.BaseObject,[bool]$false))
    $retained=$commandType.GetProperty('RecognizedContours',$flags).GetValue($command,$null)
    $uncutJob=$commandType.GetProperty('Job',$flags).GetValue($command,$null)
    Assert ((Field $retained[0] 'Holes').Count -eq 1 -and $uncutJob.Parts[0].Holes.Length -eq 0) 'Recognized holes must remain visible without enabling solver cutouts.'
    $reviewType=$assembly.GetType('SkiaSharpTest.Forms.ContourReviewDialog',$true)
    $review=$reviewType.GetConstructors($flags)[0].Invoke([object[]]@($command.PSObject.BaseObject))
    try {
        $review.CreateControl()
        $previewBitmap=[Drawing.Bitmap]::new(640,560)
        try { $review.DrawToBitmap($previewBitmap,[Drawing.Rectangle]::new(0,0,640,560)) } finally { $previewBitmap.Dispose() }
    } finally { $review.Dispose() }
    Write-Output 'PASS inner contour review: preserved rings visible without pixel cutting'
    $commandType.GetMethod('RecognizeContours',$flags).Invoke($command,[object[]]@($canvas.PSObject.BaseObject,[bool]$true))
    $job=$commandType.GetProperty('Job',$flags).GetValue($command,$null)
    Assert ($job.Parts[0].Holes.Length -eq 0 -and $job.Name -eq 'ImageAssist contour nesting') 'TIFF crop must not submit interior artwork as solver holes.'
    Assert ([object]::ReferenceEquals($canvas[0],$source)) 'Recognition must not commit before application.'
    $nativePlacement=New-Object SparrowStudio.Core.Placement
    $nativePlacement.PartId='0'; $nativePlacement.XMm=10; $nativePlacement.YMm=10
    $validation=New-Object SparrowStudio.Core.Validation; $validation.Status='passed'
    $child=New-Object SparrowStudio.Core.Result
    $child.Reason='Complete'; $child.Placements=[SparrowStudio.Core.Placement[]]@($nativePlacement); $child.Validation=$validation; $child.UsedLengthMm=20
    $childJob=New-Object SparrowStudio.Core.Job
    $part=New-Object SparrowStudio.Core.Part; $part.Id=$job.Parts[0].Id; $part.Rotations=$job.Parts[0].Rotations
    $part.Outer=[double[][]]@($job.Parts[0].Outer[0..($job.Parts[0].Outer.Length-2)])
    $part.Holes=[double[][][]]@()
    $childJob.Parts=[SparrowStudio.Core.Part[]]@($part)
    $childJob.Settings.MaterialWidthMm=20; $childJob.Settings.SheetLengthMm=20
    $stock=New-Object SparrowStudio.Core.SheetStock
    $stock.Id='legacy'; $stock.Name='Sheet'; $stock.Quantity=1; $stock.WidthMm=20; $stock.LengthMm=20
    $childJob.Settings.SheetStock=$stock
    $sheet=New-Object SparrowStudio.Core.SheetResult; $sheet.Job=$childJob; $sheet.Result=$child
    $result=New-Object SparrowStudio.Core.Result
    $result.Reason='Complete'; $result.Validation=$validation; $result.Sheets=[SparrowStudio.Core.SheetResult[]]@($sheet); $result.UsedLengthMm=20
    $result.Placements=[SparrowStudio.Core.Placement[]]@(); $result.Unplaced=[SparrowStudio.Core.UnplacedPart[]]@()
    $solver=New-Object SparrowStudio.Core.NestingSolver
    $check=$solver.Validate($job,$result)
    Assert ($check.Status -eq 'passed') ('Native contour validation failed: '+($check.Errors -join '; '))
    $commandType.GetMethod('AcceptResult',$flags).Invoke($command,[object[]]@($result.PSObject.BaseObject,$check.PSObject.BaseObject,[Threading.CancellationToken]::None,$false))
    $command.Execute()
    Assert (-not [object]::ReferenceEquals($canvas[0],$source)) 'Commit must use cropped copy.'
    $command.Undo(); Assert ([object]::ReferenceEquals($canvas[0],$source)) 'Undo must restore original instance.'
    $command.Execute(); Assert (-not [object]::ReferenceEquals($canvas[0],$source)) 'Redo must restore cropped copy.'
    Write-Output 'PASS Sparrow wiring: real holes, atomic commit, exact instance undo and redo'
    Assert (Test-Path -LiteralPath $SamplePath) 'Sample TIFF not found; pass -SamplePath explicitly.'
    if(Test-Path -LiteralPath $SamplePath) {
        $before=(Get-FileHash -LiteralPath $SamplePath -Algorithm SHA256).Hash
        $global.GetField('diplayDpi',$static).SetValue($null,[Drawing.Point]::new(60,60))
        $sample=Image $SamplePath
        $watch=[Diagnostics.Stopwatch]::StartNew()
        $sampleSolid=Recognize $sample $false
        $sampleCut=Recognize $sample $true
        $watch.Stop()
        Assert ((Field $sampleSolid 'Outer').Count -gt 4 -and (Field $sampleSolid 'Outer').Count -lt 800) 'Sample contour must retain shape with reduced solver complexity.'
        Assert ((Field $sampleSolid 'Holes').Count -gt 0 -and (Field $sampleSolid 'Holes').Count -eq (Field $sampleCut 'Holes').Count) 'All recognized holes must survive regardless of cutting choice.'
        Write-Output ('PASS sample recognition time for both cut modes: '+$watch.ElapsedMilliseconds+' ms')
        $lowWatch=[Diagnostics.Stopwatch]::StartNew()
        $lowMethod=$helper.GetMethod('RecognizeLow',$static)
        Assert ($null -ne $lowMethod) 'Original polygon recognition low precision entrypoint missing.'
        $lowSolid=$lowMethod.Invoke($null,[object[]]@($sample.PSObject.BaseObject,[bool]$false))
        $lowCut=$lowMethod.Invoke($null,[object[]]@($sample.PSObject.BaseObject,[bool]$true))
        $lowWatch.Stop()
        $lowAlpha=$lowMethod.Invoke($null,[object[]]@((Image $alphaPath).PSObject.BaseObject,[bool]$true))
        Assert ((Field $lowAlpha 'Outer').Count -ge 4 -and (Field $lowAlpha 'Holes').Count -eq 1) 'Legacy alpha recognition must retain white foreground and its hole.'
        Assert ((Field $lowSolid 'Outer').Count -gt 4) 'Legacy recognition must preserve sample shape.'
        Assert ((Field $lowSolid 'Holes').Count -gt 0 -and (Field $lowSolid 'Holes').Count -eq (Field $lowCut 'Holes').Count) 'Legacy precision must retain inner contours independently of cutting.'
        Assert ((Field $lowSolid 'Area') -eq (Field $lowCut 'Area')) 'TIFF crop must preserve low precision geometry area.'
        Assert (Field $lowCut 'RecognitionReused') 'Low precision geometry must be reused when TIFF crop changes.'
        $lowImage=Field $lowCut 'Image'
        Assert ($lowImage.PixelWidth -eq $sample.PixelWidth -and $lowImage.PixelHeight -eq $sample.PixelHeight) 'Low precision must not resize the full resolution output image.'
        Assert ([Math]::Abs($lowImage.Dpi.x-$sample.Dpi.x) -lt 0.01 -and [Math]::Abs($lowImage.Dpi.y-$sample.Dpi.y) -lt 0.01) 'Low precision must preserve physical scale.'
        $sampleCanvas=[Activator]::CreateInstance($listType); $sampleCanvas.Add($sample)
        $lowCommand=$commandType.GetConstructors($flags)[0].Invoke([object[]]@($sampleCanvas,[double]100,[double]100,[double]0,[double]7,[bool]$false))
        $commandType.GetMethod('RecognizeContoursWithPrecision',$flags).Invoke($lowCommand,[object[]]@($sampleCanvas.PSObject.BaseObject,[bool]$true,[bool]$true))
        $lowJob=$commandType.GetProperty('Job',$flags).GetValue($lowCommand,$null)
        Assert ($lowJob.Parts[0].Holes.Length -eq 0) 'Selected low precision must not cut interior artwork through TIFF crop option.'
        $lowRetained=$commandType.GetProperty('RecognizedContours',$flags).GetValue($lowCommand,$null)
        Assert ((Field $lowRetained[0] 'Holes').Count -eq (Field $lowCut 'Holes').Count) 'Low precision retained holes must remain reviewable.'
        Assert ([object]::ReferenceEquals($sampleCanvas[0],$sample)) 'Low precision recognition must not commit canvas before layout acceptance.'
        Write-Output ('PASS original polygon low precision: vertices='+((Field $lowSolid 'Outer').Count)+'; holes='+((Field $lowSolid 'Holes').Count)+'; both cut modes='+$lowWatch.ElapsedMilliseconds+' ms')
        Assert ($before -eq (Get-FileHash -LiteralPath $SamplePath -Algorithm SHA256).Hash) 'Sample TIFF changed.'
        Write-Output ('PASS sample TIFF: outer vertices='+((Field $sampleSolid 'Outer').Count)+'; holes='+((Field $sampleCut 'Holes').Count)+'; area='+[Math]::Round((Field $sampleSolid 'Area'),2)+' mm2; original unchanged')
    }
} finally {
    if($resolver) { [AppDomain]::CurrentDomain.remove_AssemblyResolve($resolver) }
    Pop-Location
}
