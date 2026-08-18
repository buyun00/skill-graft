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
    $commandLine = 'cmd.exe /c npm.cmd run dev'
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
    $runner = Join-Path $logDir 'start-panel-run.cmd'
    $runnerLines = @(
        '@echo off',
        ('cd /d "' + $panelRoot + '"'),
        ('"' + $node.Source + '" server/index.mjs >> "' + $stdoutLog + '" 2>> "' + $stderrLog + '"')
    )
    Set-Content -LiteralPath $runner -Value $runnerLines -Encoding ASCII
    $commandLine = 'cmd.exe /c "' + $runner + '"'
}

$startArgs = @{
    CommandLine = $commandLine
    CurrentDirectory = $panelRoot
}
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $startArgs
if ([int]$created.ReturnValue -ne 0 -or -not $created.ProcessId) {
    throw "Failed to start panel via WMI (code $($created.ReturnValue))"
}

$startedId = [int]$created.ProcessId
[System.IO.File]::WriteAllText($pidFile, [string]$startedId)
$deadline = [DateTime]::UtcNow.AddSeconds(8)
while (-not (Test-PanelUp)) {
    $alive = Get-Process -Id $startedId -ErrorAction SilentlyContinue
    if (-not $alive) {
        $err = ''
        $out = ''
        if (Test-Path $stderrLog) { $err = Get-Content -Raw $stderrLog }
        if (Test-Path $stdoutLog) { $out = Get-Content -Raw $stdoutLog }
        throw "Panel process exited (pid $startedId). stderr=$err stdout=$out"
    }
    if ([DateTime]::UtcNow -gt $deadline) {
        throw "Panel did not start listening on $port within 8s. See $stderrLog"
    }
    Start-Sleep -Milliseconds 200
}

Write-Output "Panel started (pid $startedId). Open http://127.0.0.1:$port/ or http://localhost:$port/"
