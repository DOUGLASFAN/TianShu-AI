param([switch]$KeepServices)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskRecordPath = Join-Path $taskRoot '.local/config/application-processes.json'
if (Test-Path -LiteralPath $taskRecordPath) {
    $taskRecords = Get-Content -LiteralPath $taskRecordPath -Raw | ConvertFrom-Json
    foreach ($taskName in @('api','web','worker')) {
        $taskRecord = $taskRecords.$taskName
        if (-not $taskRecord -or -not $taskRecord.pid -or -not $taskRecord.startedAt) { continue }
        $taskProcess = Get-Process -Id $taskRecord.pid -ErrorAction SilentlyContinue
        if (-not $taskProcess) { continue }
        $taskRecordedTime = if ($taskRecord.startedAt -is [datetime]) { $taskRecord.startedAt.ToUniversalTime() } else { [datetimeoffset]::Parse($taskRecord.startedAt).UtcDateTime }
        if ([math]::Abs(($taskProcess.StartTime.ToUniversalTime() - $taskRecordedTime).TotalSeconds) -gt 1) { throw "Process identity changed for $taskName; no action taken." }
        Stop-Process -Id $taskProcess.Id
    }
}
if (-not $KeepServices) {
    & (Join-Path $taskRoot 'backend/.venv/Scripts/python.exe') scripts/local_services.py stop
    if ($LASTEXITCODE -ne 0) { throw 'Project services could not stop cleanly.' }
}
Write-Output 'Star Nexus stopped; database files and user data preserved.'
