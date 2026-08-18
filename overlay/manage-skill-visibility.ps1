[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [ValidateSet('Disable', 'Restore')]
    [string]$Mode = 'Disable'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HubLib.ps1')

$workspace = Get-NormalizedPath $Workspace
$hubRoot = Get-HubRoot
$agentSkillsRoot = Join-Path $workspace '.agents\skills'
$keptAgentSkillNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
@(
    'ozdqp-development',
    'ozdqp-ui-development',
    'ozdqp-git-workflow',
    'unity-skills'
) | ForEach-Object { [void]$keptAgentSkillNames.Add($_) }

$adoptedRoot = Join-Path $hubRoot 'skills\adopted'
if (Test-Path -LiteralPath $adoptedRoot) {
    Get-ChildItem -LiteralPath $adoptedRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        [void]$keptAgentSkillNames.Add($_.Name)
    }
}

$legacyRoots = @(
    (Join-Path $workspace '.claude'),
    (Join-Path $workspace '.codex\agents'),
    (Join-Path $workspace '.codex\scripts'),
    (Join-Path $workspace '.codex\skills')
)
$legacyFiles = @(
    (Join-Path $workspace '.codex\cursor-rules.env')
)

function Assert-SafeRemovalPath([string]$path) {
    $full = [System.IO.Path]::GetFullPath($path)
    $prefix = $workspace.TrimEnd('\') + '\'
    if ($full -eq $workspace -or -not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe removal path: $full"
    }
}

function Test-KeptAgentSkillPath([string]$relativePath) {
    foreach ($name in $keptAgentSkillNames) {
        if ($relativePath.StartsWith(".agents/skills/$name/", [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Get-LegacyTrackedPaths {
    $lines = @(& git -C $workspace -c core.quotepath=false ls-files .agents .claude .codex)
    if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed' }
    return @($lines | Where-Object {
        $path = $_
        if ($path.StartsWith('.claude/', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        if ($path.StartsWith('.agents/skills/', [System.StringComparison]::OrdinalIgnoreCase)) {
            return -not (Test-KeptAgentSkillPath $path)
        }
        return (
            $path.StartsWith('.codex/agents/', [System.StringComparison]::OrdinalIgnoreCase) -or
            $path.StartsWith('.codex/scripts/', [System.StringComparison]::OrdinalIgnoreCase) -or
            $path.StartsWith('.codex/skills/', [System.StringComparison]::OrdinalIgnoreCase) -or
            $path.Equals('.codex/cursor-rules.env', [System.StringComparison]::OrdinalIgnoreCase)
        )
    })
}

function Invoke-ChunkedGit([string[]]$prefixArguments, [string[]]$paths) {
    $chunkSize = 50
    for ($offset = 0; $offset -lt $paths.Count; $offset += $chunkSize) {
        $last = [Math]::Min($offset + $chunkSize - 1, $paths.Count - 1)
        $chunk = @($paths[$offset..$last])
        & git -C $workspace @prefixArguments -- @chunk
        if ($LASTEXITCODE -ne 0) { throw "git $($prefixArguments -join ' ') failed" }
    }
}

function Remove-LegacyWorkspaceContent {
    foreach ($path in $legacyRoots + $legacyFiles) {
        Assert-SafeRemovalPath $path
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }
    if (Test-Path -LiteralPath $agentSkillsRoot) {
        $legacyAgentDirectories = @(Get-ChildItem -LiteralPath $agentSkillsRoot -Force -Directory | Where-Object {
            -not $keptAgentSkillNames.Contains($_.Name)
        })
        foreach ($directory in $legacyAgentDirectories) {
            Assert-SafeRemovalPath $directory.FullName
            Remove-Item -LiteralPath $directory.FullName -Recurse -Force
        }
    }
}

$trackedTargets = @(Get-LegacyTrackedPaths)
if ($Mode -eq 'Disable') {
    if ($trackedTargets.Count -gt 0) {
        Invoke-ChunkedGit @('update-index', '--skip-worktree') $trackedTargets
    }
    Remove-LegacyWorkspaceContent
    Write-Output "Stripped official assistant tree in $workspace ($($trackedTargets.Count) tracked files skip-worktree)."
    return
}

if ($trackedTargets.Count -gt 0) {
    Invoke-ChunkedGit @('update-index', '--no-skip-worktree') $trackedTargets
    Invoke-ChunkedGit @('checkout-index', '--force') $trackedTargets
}
Write-Output "Restored official assistant tree in $workspace ($($trackedTargets.Count) files)."
