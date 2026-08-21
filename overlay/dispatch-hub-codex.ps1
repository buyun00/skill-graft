[CmdletBinding()]
param()

# Deprecated v0 compatibility facade. Session creation, concurrency policy,
# analysis, and suggestion persistence are owned by Application contract v1.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-SkillGraftCommand {
    $command = Get-Command -Name 'sg' -CommandType Application,ExternalScript -ErrorAction Stop |
        Select-Object -First 1
    if ($null -eq $command -or [string]::IsNullOrWhiteSpace([string]$command.Source)) {
        throw 'installed sg command was not found on PATH'
    }
    return [string]$command.Source
}

$hubRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sg = Resolve-SkillGraftCommand
$hadHubRoot = Test-Path -LiteralPath 'Env:HUB_ROOT'
$previousHubRoot = $env:HUB_ROOT
try {
    $env:HUB_ROOT = $hubRoot
    & $sg 'analyze' '--contract-v1'
    $sgExitCode = $LASTEXITCODE
    $sgSucceeded = $?
} finally {
    if ($hadHubRoot) {
        $env:HUB_ROOT = $previousHubRoot
    } else {
        Remove-Item -LiteralPath 'Env:HUB_ROOT' -ErrorAction SilentlyContinue
    }
}

if ($null -eq $sgExitCode) {
    $sgExitCode = if ($sgSucceeded) { 0 } else { 1 }
}
exit ([int]$sgExitCode)
