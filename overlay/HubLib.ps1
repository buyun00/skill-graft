Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedPath([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) {
        throw 'Path must not be empty'
    }
    $full = [System.IO.Path]::GetFullPath($path.Trim())
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $full
    }
    return $full.TrimEnd([char[]]@('\', '/'))
}

function Resolve-SafePackageRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Locator,
        [string]$Worktree,
        [string]$Source = 'Package locator'
    )

    $candidate = $Locator.Trim()
    if ($candidate -ne $Locator) {
        throw "$Source must not have surrounding whitespace"
    }
    if (-not [System.IO.Path]::IsPathRooted($candidate)) {
        throw "$Source must be an absolute path"
    }
    $resolved = Get-NormalizedPath $candidate
    if ($resolved.Equals([System.IO.Path]::GetPathRoot($resolved), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Source must not be a filesystem root"
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "$Source is not an existing directory: $resolved"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $resolved 'overlay') -PathType Container)) {
        throw "$Source does not contain the Skill Graft overlay directory: $resolved"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $resolved 'dist\control\cli.js') -PathType Leaf)) {
        throw "$Source does not contain the Skill Graft CLI entry: $resolved"
    }

    if (-not [string]::IsNullOrWhiteSpace($Worktree)) {
        $workspace = Get-NormalizedPath $Worktree
        $workspacePrefix = $workspace.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
        if ($resolved.Equals($workspace, [System.StringComparison]::OrdinalIgnoreCase) -or
            $resolved.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "$Source must be outside the target worktree: $resolved"
        }
    }
    return $resolved
}

function Get-SkillGraftPackageRoot {
    [CmdletBinding()]
    param(
        [string]$Worktree,
        [string]$PackageRoot
    )

    $workspace = $null
    if (-not [string]::IsNullOrWhiteSpace($Worktree)) {
        $workspace = Get-GameRepoRoot $Worktree
    }
    if (-not [string]::IsNullOrWhiteSpace($PackageRoot)) {
        return Resolve-SafePackageRoot -Locator $PackageRoot -Worktree $workspace -Source 'PackageRoot'
    }
    if ($null -eq $workspace) {
        $workspace = Get-GameRepoRoot (Get-Location).Path
    }

    $configured = (& git -C $workspace config --get ozdqp.localOverlaySource 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$configured)) {
        throw "Target worktree has no ozdqp.localOverlaySource: $workspace"
    }
    return Resolve-SafePackageRoot -Locator ([string]$configured) -Worktree $workspace -Source 'ozdqp.localOverlaySource'
}

function Resolve-SafeDataRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Locator,
        [string]$Source = 'DataRoot'
    )

    $candidate = $Locator.Trim()
    if ($candidate -ne $Locator) {
        throw "$Source must not have surrounding whitespace"
    }
    if (-not [System.IO.Path]::IsPathRooted($candidate)) {
        throw "$Source must be an absolute path"
    }
    $resolved = Get-NormalizedPath $candidate
    if ($resolved.Equals([System.IO.Path]::GetPathRoot($resolved), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Source must not be a filesystem root"
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "$Source is not an existing directory: $resolved"
    }
    return $resolved
}

function Get-SkillGraftDataRoot {
    [CmdletBinding()]
    param(
        [string]$DataRoot,
        [string]$FallbackPackageRoot
    )

    $primary = $env:SKILL_GRAFT_HOME
    $legacy = $env:HUB_ROOT
    $resolvedPrimary = $null
    $resolvedLegacy = $null
    if ($null -ne $primary -and $primary -ne '') {
        $resolvedPrimary = Resolve-SafeDataRoot -Locator $primary -Source 'SKILL_GRAFT_HOME'
    }
    if ($null -ne $legacy -and $legacy -ne '') {
        $resolvedLegacy = Resolve-SafeDataRoot -Locator $legacy -Source 'HUB_ROOT'
    }
    if ($null -ne $resolvedPrimary -and $null -ne $resolvedLegacy -and
        -not $resolvedPrimary.Equals($resolvedLegacy, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'SKILL_GRAFT_HOME and HUB_ROOT resolve to different data roots'
    }

    if ($null -ne $DataRoot -and $DataRoot -ne '') {
        return Resolve-SafeDataRoot -Locator $DataRoot -Source 'DataRoot'
    }
    if ($null -ne $resolvedPrimary) { return $resolvedPrimary }
    if ($null -ne $resolvedLegacy) { return $resolvedLegacy }
    if ([string]::IsNullOrWhiteSpace($FallbackPackageRoot)) {
        throw 'DataRoot, SKILL_GRAFT_HOME, or HUB_ROOT is required'
    }
    return Resolve-SafeDataRoot -Locator $FallbackPackageRoot -Source 'default package data root'
}

function Test-SameVolume([string]$left, [string]$right) {
    return ([System.IO.Path]::GetPathRoot((Get-NormalizedPath $left))).Equals(
        [System.IO.Path]::GetPathRoot((Get-NormalizedPath $right)),
        [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-FileHashValue([string]$path) {
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-LinkTarget([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { return $null }
    $targets = @($item.Target)
    if ($targets.Count -lt 1 -or [string]::IsNullOrWhiteSpace([string]$targets[0])) { return $null }
    $target = [string]$targets[0]
    if (-not [System.IO.Path]::IsPathRooted($target)) {
        $target = Join-Path $item.DirectoryName $target
    }
    return Get-NormalizedPath $target
}

function Test-PointsTo([string]$path, [string]$expected) {
    $actual = Get-LinkTarget $path
    if ([string]::IsNullOrWhiteSpace($actual)) { return $false }
    return $actual.Equals((Get-NormalizedPath $expected), [System.StringComparison]::OrdinalIgnoreCase)
}

function New-HubDirectoryLink([string]$linkPath, [string]$targetPath) {
    $target = Get-NormalizedPath $targetPath
    $link = Get-NormalizedPath $linkPath
    if (Test-PointsTo $link $target) { return 'unchanged' }
    if (Test-Path -LiteralPath $link) {
        Remove-Item -LiteralPath $link -Recurse -Force
    }
    $parent = Split-Path -Parent $link
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Force -Path $parent)
    }
    if (Test-SameVolume $link $target) {
        [void](New-Item -ItemType Junction -Path $link -Target $target)
        return 'junction'
    }
    [void](New-Item -ItemType SymbolicLink -Path $link -Target $target)
    return 'symlink'
}

function New-HubFileLink([string]$linkPath, [string]$targetPath) {
    $target = Get-NormalizedPath $targetPath
    $link = Get-NormalizedPath $linkPath
    if (Test-PointsTo $link $target) { return 'unchanged' }
    if (Test-Path -LiteralPath $link) {
        Remove-Item -LiteralPath $link -Force
    }
    $parent = Split-Path -Parent $link
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Force -Path $parent)
    }
    try {
        [void](New-Item -ItemType SymbolicLink -Path $link -Target $target)
        return 'symlink'
    } catch {
        [void](New-Item -ItemType HardLink -Path $link -Target $target)
        return 'hardlink'
    }
}

function Read-HubList([string]$filePath) {
    if (-not (Test-Path -LiteralPath $filePath)) { return @() }
    return @(Get-Content -LiteralPath $filePath -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
}

function Add-HubListPath([string]$filePath, [string]$path) {
    $normalized = Get-NormalizedPath $path
    $current = @(Read-HubList $filePath)
    if ($current | Where-Object { $_.Equals($normalized, [System.StringComparison]::OrdinalIgnoreCase) }) { return }
    $parent = Split-Path -Parent $filePath
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Force -Path $parent)
    }
    Add-Content -LiteralPath $filePath -Value $normalized -Encoding UTF8
}

function Test-HubListContains([string]$filePath, [string]$path) {
    $normalized = Get-NormalizedPath $path
    return [bool]@(Read-HubList $filePath | Where-Object { $_.Equals($normalized, [System.StringComparison]::OrdinalIgnoreCase) })
}

function Get-GameRepoRoot([string]$worktree) {
    $root = (& git -C $worktree rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "Not a git worktree: $worktree" }
    return Get-NormalizedPath $root.Trim()
}

function Write-JsonFile([string]$path, $object) {
    $parent = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Force -Path $parent)
    }
    $json = $object | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Read-JsonFile([string]$path, $fallback) {
    if (-not (Test-Path -LiteralPath $path)) { return $fallback }
    return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function New-HistoryRecord([string]$hubRoot, [hashtable]$record) {
    $dir = Join-Path $hubRoot 'skill-review\history'
    [void](New-Item -ItemType Directory -Force -Path $dir)
    $stamp = [DateTimeOffset]::Now.ToString('yyyyMMdd-HHmmss')
    $name = '{0}-{1}.json' -f $stamp, ([guid]::NewGuid().ToString('N').Substring(0, 8))
    if (-not $record.ContainsKey('at')) { $record['at'] = [DateTimeOffset]::Now.ToString('o') }
    Write-JsonFile (Join-Path $dir $name) ([pscustomobject]$record)
}
