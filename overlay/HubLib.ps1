Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-HubRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
}

function Get-NormalizedPath([string]$path) {
    return [System.IO.Path]::GetFullPath($path.Trim()).TrimEnd('\')
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
