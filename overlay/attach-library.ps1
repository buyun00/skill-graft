[CmdletBinding()]
param(
    [string]$TargetWorktree,
    [switch]$AllWorktrees,
    [switch]$PreferLibrary,
    [switch]$PromoteFromWorktree,
    [switch]$SkipVisibility,
    [switch]$ConfigureGit,
    [string]$SessionId,
    [string]$RequestId,
    [Alias('HostRoot')]
    [string]$PackageRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HubLib.ps1')

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

$packageRoot = Get-SkillGraftPackageRoot -Worktree $TargetWorktree -PackageRoot $PackageRoot
$cli = Join-Path $packageRoot 'dist\control\cli.js'
$node = Get-Command -Name 'node' -CommandType Application -ErrorAction Stop | Select-Object -First 1
& $node.Source $cli @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
