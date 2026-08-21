[CmdletBinding()]
param(
    [string]$TargetWorktree,
    [switch]$AllWorktrees,
    [switch]$PreferLibrary,
    [switch]$PromoteFromWorktree,
    [switch]$SkipVisibility,
    [switch]$ConfigureGit,
    [string]$SessionId,
    [string]$RequestId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($AllWorktrees) {
    throw '-AllWorktrees is reserved and must not be used in this phase. Attach one worktree at a time.'
}
if ([string]::IsNullOrWhiteSpace($TargetWorktree)) {
    $TargetWorktree = (Get-Location).Path
}

$sourcePolicy = 'requireMatch'
if ($PreferLibrary) {
    $sourcePolicy = 'preferLibrary'
    if ($PromoteFromWorktree) {
        Write-Warning '-PreferLibrary and -PromoteFromWorktree were both supplied; preserving legacy PreferLibrary precedence.'
    }
} elseif ($PromoteFromWorktree) {
    $sourcePolicy = 'promoteFromWorktree'
}

$arguments = @(
    'apply-legacy-attach',
    '--worktree', $TargetWorktree,
    '--source-policy', $sourcePolicy,
    '--visibility', $(if ($SkipVisibility) { 'preserve' } else { 'disable' })
)
if ($ConfigureGit) { $arguments += '--configure-git' }
if (-not [string]::IsNullOrWhiteSpace($SessionId)) { $arguments += @('--session-id', $SessionId) }
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
