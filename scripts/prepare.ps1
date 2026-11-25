param([switch]$SkipServiceTools, [string]$CacheDirectory)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $CacheDirectory) { $CacheDirectory = Join-Path $projectRoot '.local/cache' }
$CacheDirectory = [IO.Path]::GetFullPath($CacheDirectory)
Push-Location -LiteralPath $projectRoot
try {
    $python = Join-Path $projectRoot 'backend/.venv/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $python)) {
        & py.exe -3.12 -m venv backend/.venv
        if ($LASTEXITCODE) { throw 'Creating the Python 3.12 environment failed.' }
    }
    & $python -m pip install --cache-dir (Join-Path $CacheDirectory 'pip') -r backend/requirements.lock.txt
    if ($LASTEXITCODE) { throw 'Installing locked backend dependencies failed.' }
    & npm.cmd ci --prefix frontend --cache (Join-Path $CacheDirectory 'npm')
    if ($LASTEXITCODE) { throw 'Installing locked frontend dependencies failed.' }
    & npm.cmd --prefix frontend run prepare-assets
    if ($LASTEXITCODE) { throw 'Preparing local frontend assets failed.' }
    if (-not $SkipServiceTools) {
        & $python scripts/prepare_local_services.py
        if ($LASTEXITCODE) { throw 'Preparing PostgreSQL and Redis tools failed.' }
    }
    Write-Output 'Preparation completed.'
} finally {
    Pop-Location
}
