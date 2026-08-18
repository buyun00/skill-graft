[CmdletBinding()]
param(
    [string]$TargetWorktree,
    [switch]$AllWorktrees,
    [switch]$PreferLibrary,
    [switch]$PromoteFromWorktree,
    [switch]$SkipVisibility,
    [switch]$ConfigureGit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HubLib.ps1')

$hubRoot = Get-HubRoot
if ($AllWorktrees) {
    throw '-AllWorktrees is reserved and must not be used in this phase. Attach one worktree at a time.'
}

if ([string]::IsNullOrWhiteSpace($TargetWorktree)) {
    $TargetWorktree = (Get-Location).Path
}

$targetRoot = Get-GameRepoRoot $TargetWorktree
$skillNames = @('ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow')

function Get-DirFileMap([string]$root) {
    $map = @{}
    if (-not (Test-Path -LiteralPath $root)) { return $map }
    Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object {
        $rel = $_.FullName.Substring((Get-NormalizedPath $root).Length).TrimStart('\').Replace('\', '/')
        $map[$rel] = Get-FileHashValue $_.FullName
    }
    return $map
}

function Test-MapsEqual($left, $right) {
    if ($left.Count -ne $right.Count) { return $false }
    foreach ($key in $left.Keys) {
        if (-not $right.ContainsKey($key)) { return $false }
        if ($left[$key] -ne $right[$key]) { return $false }
    }
    return $true
}

function Assert-SafeToReplace([string]$worktreePath, [string]$hubPath, [string]$label) {
    if (-not (Test-Path -LiteralPath $worktreePath)) { return }
    if (Test-PointsTo $worktreePath $hubPath) { return }
    $item = Get-Item -LiteralPath $worktreePath -Force
    $isLink = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isLink) {
        throw "$label already points elsewhere: $worktreePath -> $(Get-LinkTarget $worktreePath)"
    }
    if (Test-Path -LiteralPath $worktreePath -PathType Container) {
        $equal = Test-MapsEqual (Get-DirFileMap $worktreePath) (Get-DirFileMap $hubPath)
    } else {
        $equal = (Test-Path -LiteralPath $hubPath) -and ((Get-FileHashValue $worktreePath) -eq (Get-FileHashValue $hubPath))
    }
    if ($equal) { return }
    if ($PreferLibrary) { return }
    if ($PromoteFromWorktree) {
        if (Test-Path -LiteralPath $worktreePath -PathType Container) {
            if (Test-Path -LiteralPath $hubPath) { Remove-Item -LiteralPath $hubPath -Recurse -Force }
            Copy-Item -Recurse -Force $worktreePath $hubPath
        } else {
            Copy-Item -Force $worktreePath $hubPath
        }
        return
    }
    throw "$label differs from hub. Re-run with -PreferLibrary or -PromoteFromWorktree: $worktreePath"
}

Assert-SafeToReplace (Join-Path $targetRoot 'AGENTS.override.md') (Join-Path $hubRoot 'AGENTS.override.md') 'AGENTS.override.md'
foreach ($name in $skillNames) {
    Assert-SafeToReplace (Join-Path $targetRoot ".agents\skills\$name") (Join-Path $hubRoot "skills\$name") $name
}

if ($ConfigureGit) {
    & git -C $targetRoot config core.hooksPath (Join-Path $hubRoot 'overlay\hooks')
}

$overlayTarget = Join-Path $targetRoot '.codex\local-overlay'
$hubOverlay = Join-Path $hubRoot 'overlay'
if (Test-Path -LiteralPath $overlayTarget) {
    $alreadyLinked = Test-PointsTo $overlayTarget $hubOverlay
    if (-not $alreadyLinked) {
        $overlayItem = Get-Item -LiteralPath $overlayTarget -Force
        $isLink = ($overlayItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        if (-not $isLink) {
            $backup = Join-Path $targetRoot ('.codex\local-overlay.pre-hub-{0}' -f [DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
            [void](New-Item -ItemType Directory -Force -Path $backup)
            & robocopy $overlayTarget $backup /E /NFL /NDL /NJH /NJS /nc /ns /np
            if ($LASTEXITCODE -ge 8) { throw "Failed to backup local-overlay to $backup" }
            Remove-Item -LiteralPath $overlayTarget -Recurse -Force
            Write-Output "Backed up existing local-overlay to $backup"
        } else {
            Remove-Item -LiteralPath $overlayTarget -Force
        }
    }
}

$results = @()
$results += "override=$(New-HubFileLink (Join-Path $targetRoot 'AGENTS.override.md') (Join-Path $hubRoot 'AGENTS.override.md'))"
foreach ($name in $skillNames) {
    $kind = New-HubDirectoryLink (Join-Path $targetRoot ".agents\skills\$name") (Join-Path $hubRoot "skills\$name")
    $results += "$name=$kind"
}
$adoptedRoot = Join-Path $hubRoot 'skills\adopted'
if (Test-Path -LiteralPath $adoptedRoot) {
    Get-ChildItem -LiteralPath $adoptedRoot -Directory | ForEach-Object {
        $kind = New-HubDirectoryLink (Join-Path $targetRoot ".agents\skills\$($_.Name)") $_.FullName
        $results += "adopted:$($_.Name)=$kind"
    }
}
$results += "overlay=$(New-HubDirectoryLink $overlayTarget $hubOverlay)"

if (-not $SkipVisibility) {
    & (Join-Path $PSScriptRoot 'manage-skill-visibility.ps1') -Workspace $targetRoot -Mode Disable
}

Add-HubListPath (Join-Path $hubRoot 'overlay\attached-worktrees.txt') $targetRoot

if ($ConfigureGit) {
    & git -C $targetRoot config ozdqp.localOverlaySource $hubRoot
    & git -C $targetRoot config ozdqp.skillWatchWorkspace $hubRoot
    & git -C $targetRoot config ozdqp.skillWatchEnabled true
    & git -C $targetRoot config core.hooksPath (Join-Path $hubRoot 'overlay\hooks')
    & git -C $hubRoot config ozdqp.gameRepo $targetRoot
}

Write-Output "Attached $targetRoot -> $hubRoot"
$results | ForEach-Object { Write-Output "  $_" }
