[CmdletBinding()]
param(
    [string]$Workspace,
    [Alias('HostRoot')]
    [string]$PackageRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HubLib.ps1')

if ([string]::IsNullOrWhiteSpace($Workspace)) {
    $Workspace = (Get-Location).Path
}

$workspace = Get-GameRepoRoot $Workspace
[void](Get-SkillGraftPackageRoot -Worktree $workspace -PackageRoot $PackageRoot)
$generatedSkill = Get-NormalizedPath (Join-Path $workspace 'baloot_client\.agents\skills\unity-skills')
$rootSkill = Get-NormalizedPath (Join-Path $workspace '.agents\skills\unity-skills')

if (-not (Test-Path -LiteralPath (Join-Path $generatedSkill 'SKILL.md') -PathType Leaf)) {
    throw "Generated UnitySkills package is missing: $generatedSkill"
}

if (Test-PointsTo $rootSkill $generatedSkill) {
    Write-Output "UnitySkills root registration already exists: $rootSkill -> $generatedSkill"
    return
}

if (Test-Path -LiteralPath $rootSkill) {
    $existing = Get-Item -LiteralPath $rootSkill -Force
    if (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "Root UnitySkills path exists but is not a Junction: $rootSkill"
    }
    throw "Root UnitySkills Junction points elsewhere: $rootSkill"
}

[void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $rootSkill))
[void](New-Item -ItemType Junction -Path $rootSkill -Target $generatedSkill)
Write-Output "Registered UnitySkills at workspace root: $rootSkill -> $generatedSkill"
