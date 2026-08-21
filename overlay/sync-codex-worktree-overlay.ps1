[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetWorktree,
    [string]$RequestId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$arguments = @('repair-links', '--worktree', $TargetWorktree)
if (-not [string]::IsNullOrWhiteSpace($RequestId)) { $arguments += @('--request-id', $RequestId) }

$command = Get-Command sg -ErrorAction Stop
$previousHubRoot = $env:HUB_ROOT
try {
    $env:HUB_ROOT = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
    & $command.Source @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    $env:HUB_ROOT = $previousHubRoot
}
