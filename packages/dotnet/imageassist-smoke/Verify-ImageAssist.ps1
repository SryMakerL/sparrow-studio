param([string]$AppDirectory = 'D:/work_files/2026-10-26/ImageAssist_0527_Standard_test/bin/x64/Debug')
$ErrorActionPreference = 'Stop'
Push-Location $AppDirectory
try {
    $env:PATH = $AppDirectory + ';' + $env:PATH
    foreach ($name in @('GZMath.dll','SkiaSharp.dll','Newtonsoft.Json.dll','SparrowStudio.Core.dll')) {
        [void][Reflection.Assembly]::LoadFrom((Join-Path $AppDirectory $name))
    }
    $assembly = [Reflection.Assembly]::LoadFrom((Join-Path $AppDirectory 'LCImageAssist.exe'))
    $imageType = $assembly.GetType('SkiaSharpTest.ImagePaint', $true)
    $commandType = $assembly.GetType('SkiaSharpTest.SparrowNestOpt', $true)
    $flags = [Reflection.BindingFlags]'Instance,NonPublic,Public'
    function Assert($condition, $message) { if (-not $condition) { throw $message } }
    function Image($w,$h,$x,$y,$angle) {
        $image = [Runtime.Serialization.FormatterServices]::GetUninitializedObject($imageType)
        $imageType.GetField('_width',$flags).SetValue($image,[double]$w)
        $imageType.GetField('_height',$flags).SetValue($image,[double]$h)
        $image.Position = New-Object GZMath.GZPoint([double]$x,[double]$y)
        $image.RotateAngle = $angle
        $image.isMirror = $true
        return $image
    }
    function Command($images,$w,$h,$rotate) {
        $listType = [Collections.Generic.List``1].MakeGenericType($imageType)
        $list = [Activator]::CreateInstance($listType)
        foreach ($image in $images) { $list.Add($image) }
        $ctor = $commandType.GetConstructors($flags)[0]
        return $ctor.Invoke([object[]]@($list,[double]$w,[double]$h,[double]0,[double]7,[bool]$rotate))
    }
    function Solve($command) {
        $task = $commandType.GetMethod('SolveAsync',$flags).Invoke($command,[object[]]@([Threading.CancellationToken]::None))
        $task.GetAwaiter().GetResult()
    }
    $image = Image 30 10 100 200 0
    $command = Command @($image) 12 32 $true
    Solve $command
    Assert ($image.Position.x -eq 100 -and $image.Position.y -eq 200) 'Solve mutated canvas before commit.'
    $command.Execute()
    Assert ([Math]::Abs([Math]::Abs($image.RotateAngle)-90) -lt 0.001) 'Required quarter turn missing.'
    Assert ($image.Bounding.Left -ge -0.01 -and $image.Bounding.Right -le 12.01 -and $image.Bounding.Top -ge -0.01 -and $image.Bounding.Bottom -le 32.01) 'Image bounds outside canvas.'
    $x=$image.Position.x; $y=$image.Position.y; $angle=$image.RotateAngle
    $command.Undo()
    Assert ($image.Position.x -eq 100 -and $image.Position.y -eq 200 -and $image.RotateAngle -eq 0) 'Undo did not restore exact state.'
    $command.Execute()
    Assert ($image.Position.x -eq $x -and $image.Position.y -eq $y -and $image.RotateAngle -eq $angle -and $image.isMirror) 'Redo or metadata preservation failed.'
    Write-Output 'PASS actual ImageAssist command: native solve, atomic commit, forced rotation, undo/redo, metadata'
    $a=Image 10 10 100 200 0; $b=Image 10 10 300 400 0
    $command=Command @($a,$b) 11 11 $false
    Solve $command; $command.Execute()
    $tops=@($a.Bounding.Top,$b.Bounding.Top) | Sort-Object
    Assert ($tops[0] -ge -0.01 -and $tops[1] -ge 17.99) 'Physical boards not separated vertically.'
    $command.Undo()
    Assert ($a.Position.x -eq 100 -and $b.Position.x -eq 300) 'Multi-board undo failed.'
    Write-Output 'PASS actual ImageAssist command: two boards and original instances preserved'
    $source=New-Object Threading.CancellationTokenSource
    try {
        $source.Cancel()
        $cancelled=$false
        try { $task=$commandType.GetMethod('SolveAsync',$flags).Invoke($command,[object[]]@($source.Token)); $task.GetAwaiter().GetResult() }
        catch { if ($_.Exception.ToString() -match 'cancel|取消') {$cancelled=$true} else {throw} }
        Assert $cancelled 'Cancellation was not propagated.'
        Assert ($a.Position.x -eq 100 -and $b.Position.x -eq 300) 'Cancelled operation mutated source images.'
    } finally {$source.Dispose()}
    Write-Output 'PASS actual ImageAssist command: cancellation leaves canvas unchanged'
    $job=$commandType.GetProperty('Job',$flags).GetValue($command,$null)
    $accepted=New-Object SparrowStudio.Core.Result
    $accepted.Reason='UserStopped'; $accepted.Validation=New-Object SparrowStudio.Core.Validation
    $accepted.Validation.Status='passed'; $accepted.Unplaced=[SparrowStudio.Core.UnplacedPart[]]@()
    $accepted.UsedLengthMm=20
    $sheets=New-Object 'System.Collections.Generic.List[SparrowStudio.Core.SheetResult]'
    for($i=0;$i -lt 2;$i++){
        $child=New-Object SparrowStudio.Core.Job; $child.Parts=[SparrowStudio.Core.Part[]]@($job.Parts[$i])
        $child.Settings.MaterialWidthMm=11; $child.Settings.SheetLengthMm=11
        $stock=New-Object SparrowStudio.Core.SheetStock; $stock.Id='legacy'; $stock.Name='Sheet'
        $stock.Quantity=2; $stock.WidthMm=11; $stock.LengthMm=11
        $child.Settings.SheetStock=$stock
        $p=New-Object SparrowStudio.Core.Placement; $p.PartId=$job.Parts[$i].Id; $p.XMm=5; $p.YMm=5
        $r=New-Object SparrowStudio.Core.Result; $r.Placements=[SparrowStudio.Core.Placement[]]@($p)
        $r.UsedLengthMm=10; $r.Validation=New-Object SparrowStudio.Core.Validation; $r.Validation.Status='passed'
        $sheet=New-Object SparrowStudio.Core.SheetResult; $sheet.Job=$child; $sheet.Result=$r; $sheets.Add($sheet)
    }
    $accepted.Placements=[SparrowStudio.Core.Placement[]]@(); $accepted.Sheets=$sheets.ToArray()
    $solver=New-Object SparrowStudio.Core.NestingSolver; $check=$solver.Validate($job,$accepted)
    Assert ($check.Status -eq 'passed') 'Stopped fixture must pass independent geometry validation.'
    $accept=$commandType.GetMethod('AcceptResult',$flags)
    $rejected=$false
    try { $null=$accept.Invoke($command.PSObject.BaseObject,[object[]]@($accepted.PSObject.BaseObject,$check.PSObject.BaseObject,[Threading.CancellationToken]::None,$false)) }
    catch { if ($_.FullyQualifiedErrorId -eq 'InvalidOperationException' -or $_.Exception.GetBaseException() -is [InvalidOperationException]) { $rejected=$true } else { throw } }
    Assert $rejected 'UserStopped must require explicit dialog authorization.'
    $null=$accept.Invoke($command.PSObject.BaseObject,[object[]]@($accepted.PSObject.BaseObject,$check.PSObject.BaseObject,[Threading.CancellationToken]::None,$true))
    Assert ($a.Position.x -eq 100 -and $b.Position.x -eq 300) 'AcceptResult must not commit canvas.'
    $command.Execute(); Assert ($a.Position.x -eq 5 -and $b.Position.x -eq 5) 'Authorized stopped result not applied.'
    $command.Undo(); Assert ($a.Position.x -eq 100 -and $b.Position.x -eq 300) 'Stopped result undo failed.'
    $accepted.Cancelled=$true; $rejected=$false
    try { $null=$accept.Invoke($command.PSObject.BaseObject,[object[]]@($accepted.PSObject.BaseObject,$check.PSObject.BaseObject,[Threading.CancellationToken]::None,$true)) }
    catch { if ($_.FullyQualifiedErrorId -eq 'InvalidOperationException' -or $_.Exception.GetBaseException() -is [InvalidOperationException]) { $rejected=$true } else { throw } }
    Assert $rejected 'Cancelled native result must never be accepted as UserStopped.'
    Write-Output 'PASS actual ImageAssist command: authorized current result, cancelled rejection and undo'
} finally { Pop-Location }
