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

function Test-PortListening([int]$portNumber) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $portNumber)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

if (Test-PortListening $port) {
    Write-Output "Panel already listening at http://127.0.0.1:$port/"
    return
}

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
    throw 'Node.js / npm is required for the skill hub panel. Do not fall back to a Python page.'
}

Push-Location $panelRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $panelRoot 'node_modules'))) {
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    }
    if ($Dev) {
        Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev') -WorkingDirectory $panelRoot
        Write-Output "Started panel dev server. Open http://127.0.0.1:$port/"
        return
    }
    if (-not (Test-Path -LiteralPath (Join-Path $panelRoot 'dist\index.html'))) {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
    }
    Start-Process -FilePath $node.Source -ArgumentList @('server/index.mjs') -WorkingDirectory $panelRoot
    Start-Sleep -Seconds 1
    Write-Output "Started panel at http://127.0.0.1:$port/"
} finally {
    Pop-Location
}
