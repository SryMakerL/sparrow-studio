param([string]$AppDirectory = 'D:/work files/2026-10-26/ImageAssist_0527_Standard_test/bin/x64/Debug')
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
} finally { Pop-Location }
