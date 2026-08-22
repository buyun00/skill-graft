[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetWorktree,
    [string]$RequestId,
    [Alias('HostRoot')]
    [string]$PackageRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HubLib.ps1')

$arguments = @('repair-links', '--worktree', $TargetWorktree)
if (-not [string]::IsNullOrWhiteSpace($RequestId)) { $arguments += @('--request-id', $RequestId) }

$packageRoot = Get-SkillGraftPackageRoot -Worktree $TargetWorktree -PackageRoot $PackageRoot
$cli = Join-Path $packageRoot 'dist\control\cli.js'
$node = Get-Command -Name 'node' -CommandType Application -ErrorAction Stop | Select-Object -First 1
& $node.Source $cli @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
