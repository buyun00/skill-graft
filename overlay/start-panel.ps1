[CmdletBinding()]
param(
    [switch]$Dev
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HubLib.ps1')

$hubRoot = Get-HubRoot
$panelRoot = Join-Path $hubRoot 'panel'
$port = 18765
$logDir = Join-Path $hubRoot 'skill-review'
$stdoutLog = Join-Path $logDir 'panel.out.log'
$stderrLog = Join-Path $logDir 'panel.err.log'
$pidFile = Join-Path $logDir 'panel.pid'

function Test-PortListening([string]$address, [int]$portNumber) {
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $async = $client.BeginConnect($address, $portNumber, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne(400)
        if ($ok -and $client.Connected) {
            $client.Close()
            return $true
        }
        $client.Close()
        return $false
    } catch {
        return $false
    }
}

function Test-PanelUp {
    return (Test-PortListening '127.0.0.1' $port) -or (Test-PortListening '::1' $port)
}

if (Test-PanelUp) {
    Write-Output "Panel already listening. Open http://127.0.0.1:$port/ or http://localhost:$port/"
    return
}

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
    throw 'Node.js / npm is required for the skill hub panel. Do not fall back to a Python page.'
}

[void](New-Item -ItemType Directory -Force -Path $logDir)
if (-not (Test-Path -LiteralPath (Join-Path $panelRoot 'node_modules'))) {
    Push-Location $panelRoot
    try {
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    } finally {
        Pop-Location
    }
}

if ($Dev) {
    $proc = Start-Process -FilePath 'npm.cmd' -WorkingDirectory $panelRoot -PassThru `
        -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
        -ArgumentList @('run', 'dev')
} else {
    if (-not (Test-Path -LiteralPath (Join-Path $panelRoot 'dist\index.html'))) {
        Push-Location $panelRoot
        try {
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
        } finally {
            Pop-Location
        }
    }
    foreach ($oldLog in @($stdoutLog, $stderrLog)) {
        if (Test-Path -LiteralPath $oldLog) { Remove-Item -LiteralPath $oldLog -Force }
    }
    $proc = Start-Process -FilePath $node.Source -WorkingDirectory $panelRoot -PassThru `
        -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
        -ArgumentList @('server/index.mjs')
}

[System.IO.File]::WriteAllText($pidFile, [string]$proc.Id)
$deadline = [DateTime]::UtcNow.AddSeconds(8)
while (-not (Test-PanelUp)) {
    if ($proc.HasExited) {
        $err = if (Test-Path $stderrLog) { Get-Content -Raw $stderrLog } else { '' }
        $out = if (Test-Path $stdoutLog) { Get-Content -Raw $stdoutLog } else { '' }
        throw "Panel process exited (pid $($proc.Id)). stderr=$err stdout=$out"
    }
    if ([DateTime]::UtcNow -gt $deadline) {
        throw "Panel did not start listening on $port within 8s. See $stderrLog"
    }
    Start-Sleep -Milliseconds 200
}

Write-Output "Panel started (pid $($proc.Id)). Open http://127.0.0.1:$port/ or http://localhost:$port/"
