<# Shows whether the recorder is running, how the current video is filling up,
   and the most recent finished recordings. #>
$root = Split-Path -Parent $PSScriptRoot
$lock = Join-Path $root 'logs\recorder.lock'

function Format-Duration([double]$seconds) {
    $t = [TimeSpan]::FromSeconds($seconds)
    if ($t.TotalHours -ge 1) { return ('{0}h{1:00}m' -f [int]$t.TotalHours, $t.Minutes) }
    if ($t.TotalMinutes -ge 1) { return ('{0}m{1:00}s' -f [int]$t.TotalMinutes, $t.Seconds) }
    return ('{0}s' -f [int]$t.TotalSeconds)
}

Write-Host '=== Recorder ==='
if (Test-Path $lock) {
    $recorderPid = [int](Get-Content $lock -Raw).Trim()
    $proc = Get-Process -Id $recorderPid -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "Running (pid $recorderPid, started $($proc.StartTime))"
    } else {
        Write-Host "Not running (stale lock for pid $recorderPid)"
    }
} else {
    Write-Host 'Not running'
}

$ffmpeg = Get-Process ffmpeg -ErrorAction SilentlyContinue
Write-Host ("Capturing right now: " + $(if ($ffmpeg) { 'yes' } else { 'no (user idle, or paused)' }))

$cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
$outDir = if ([System.IO.Path]::IsPathRooted($cfg.outputDir)) { $cfg.outputDir } else { Join-Path $root $cfg.outputDir }

Write-Host ''
Write-Host '=== Video being recorded ==='
$statePath = Join-Path $outDir '.parts\current\state.json'
if (Test-Path $statePath) {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    $pct = if ($cfg.segmentSeconds -gt 0) { [math]::Round(100 * $state.durationSec / $cfg.segmentSeconds) } else { 0 }
    $bars = [int]($pct / 4)
    Write-Host ("Started : " + $state.startedAt)
    Write-Host ("Recorded: " + (Format-Duration $state.durationSec) + " of " + (Format-Duration $cfg.segmentSeconds) + " (" + $pct + "%)")
    Write-Host ("          [" + ('#' * $bars).PadRight(25, '.') + "]")
    Write-Host ("Clips   : " + $state.partCount)
    Write-Host 'Run "npm run finalise" to close this video now instead of waiting.'
} else {
    Write-Host 'Nothing accumulated yet.'
}

$pending = Get-ChildItem (Join-Path $outDir '.parts') -Directory -Filter 'pending-*' -ErrorAction SilentlyContinue
if ($pending) {
    Write-Host ''
    Write-Host ("Assembling: " + ($pending.Name -join ', '))
}

Write-Host ''
Write-Host '=== Scheduled task ==='
$task = Get-ScheduledTask -TaskName 'ScreenActivityRecorder' -ErrorAction SilentlyContinue
if ($task) {
    $task | Get-ScheduledTaskInfo | Select-Object TaskName, LastRunTime, LastTaskResult
} else {
    Write-Host 'Not registered (run: npm run install-autostart)'
}

Write-Host ''
Write-Host '=== Finished recordings ==='
if (Test-Path $outDir) {
    $mp4 = Get-ChildItem $outDir -Filter *.mp4 | Sort-Object LastWriteTime -Descending
    if ($mp4) {
        $mp4 | Select-Object -First 10 Name, @{n='SizeMB';e={[math]::Round($_.Length/1MB,1)}}, LastWriteTime
        Write-Host ("Total: {0} file(s), {1:N1} GB" -f $mp4.Count, (($mp4 | Measure-Object Length -Sum).Sum / 1GB))
    } else {
        Write-Host 'None finished yet.'
    }
} else {
    Write-Host "No output folder yet ($outDir)"
}

Write-Host ''
Write-Host '=== Log tail ==='
$log = Join-Path $root 'logs\monitor.log'
if (Test-Path $log) { Get-Content $log -Tail 12 } else { Write-Host 'No log yet.' }
