$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskPython = Join-Path $taskRoot 'backend/.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Prepare backend/.venv and locked dependencies first; see README.' }
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot '.local/tools/services-manifest.json'))) { throw 'Run scripts/prepare_local_services.py first; see README.' }
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'frontend/node_modules/vite/bin/vite.js'))) { throw 'Run npm ci --prefix frontend first.' }
& $taskPython scripts/local_services.py start
if ($LASTEXITCODE -ne 0) { throw 'Local service initialization failed.' }
& $taskPython -m backend.app.bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Migration/seed failed.' }
$taskLog = Join-Path $taskRoot '.local/logs'
New-Item -ItemType Directory -Force -Path $taskLog | Out-Null
$taskPids = @{}
try { $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8001/api/health/live' -TimeoutSec 2; if ($taskHealth.version -ne '0.2.0') { throw 'Unexpected service on port 8001.' } }
catch {
    if (Get-NetTCPConnection -State Listen -LocalPort 8001 -ErrorAction SilentlyContinue) { throw 'Port 8001 is occupied; existing process was not stopped.' }
    $taskBackend = Start-Process -FilePath $taskPython -ArgumentList @('-m','uvicorn','backend.app.main:app','--host','127.0.0.1','--port','8001','--ws-max-size','4096') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLog 'api.out.log') -RedirectStandardError (Join-Path $taskLog 'api.err.log')
    $taskPids.api = $taskBackend.Id
}
if (-not (Get-NetTCPConnection -State Listen -LocalPort 5174 -ErrorAction SilentlyContinue)) {
    $taskNode = (Get-Command node.exe).Source
    $taskWeb = Start-Process -FilePath $taskNode -ArgumentList @('node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5174','--strictPort') -WorkingDirectory (Join-Path $taskRoot 'frontend') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLog 'web.out.log') -RedirectStandardError (Join-Path $taskLog 'web.err.log')
    $taskPids.web = $taskWeb.Id
}
for ($taskAttempt=0; $taskAttempt -lt 30; $taskAttempt++) {
    try {
        $taskReady = Invoke-RestMethod -Uri 'http://127.0.0.1:8001/api/health/ready' -TimeoutSec 2
        $taskPage = Invoke-WebRequest -Uri 'http://127.0.0.1:5174/' -TimeoutSec 2
        if ($taskPage.StatusCode -eq 200 -and $taskPage.Content -notmatch '全球卫星态势与观测平台') { throw 'Unexpected application on port 5174.' }
        if ($taskReady.ok -and $taskPage.StatusCode -eq 200) { break }
    } catch { Start-Sleep -Milliseconds 500 }
}
if ($taskAttempt -ge 30) { throw 'Application did not become ready; inspect .local/logs.' }
$taskProcessRecords = @{}
foreach ($taskEntry in @(@{Name='api';Port=8001},@{Name='web';Port=5174})) {
    $taskPid = (Get-NetTCPConnection -State Listen -LocalPort $taskEntry.Port | Select-Object -First 1).OwningProcess
    $taskProcess = Get-Process -Id $taskPid
    $taskProcessRecords[$taskEntry.Name] = @{pid=$taskPid;startedAt=$taskProcess.StartTime.ToUniversalTime().ToString('o')}
}
$taskWorker = $null
$taskExistingRecord = Join-Path $taskRoot '.local/config/application-processes.json'
if (Test-Path -LiteralPath $taskExistingRecord) {
    $taskPrior = Get-Content -LiteralPath $taskExistingRecord -Raw | ConvertFrom-Json
    if ($taskPrior.worker) {
        $taskCandidate = Get-Process -Id $taskPrior.worker.pid -ErrorAction SilentlyContinue
        $taskRecorded = [datetimeoffset]$taskPrior.worker.startedAt
        if ($taskCandidate -and [math]::Abs(($taskCandidate.StartTime.ToUniversalTime() - $taskRecorded.UtcDateTime).TotalSeconds) -lt 1) { $taskWorker = $taskCandidate }
    }
}
if (-not $taskWorker) {
    $taskWorker = Start-Process -FilePath $taskPython -ArgumentList @('-m','backend.worker','--serve') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLog 'worker.out.log') -RedirectStandardError (Join-Path $taskLog 'worker.err.log')
}
$taskProcessRecords.worker = @{pid=$taskWorker.Id;startedAt=$taskWorker.StartTime.ToUniversalTime().ToString('o')}
$taskProcessRecords | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $taskRoot '.local/config/application-processes.json') -Encoding UTF8
Write-Output '星巡已启动: http://127.0.0.1:5174/ | account credentials: .local/config/demo-accounts.json'
