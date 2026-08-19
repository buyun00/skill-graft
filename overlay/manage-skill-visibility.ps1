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
    $previous = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $blob = & git -C $workspace -c core.quotepath=false -c i18n.logOutputEncoding=utf-8 ls-files -z .agents .claude .codex
        if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed' }
    } finally {
        [Console]::OutputEncoding = $previous
    }
    $lines = @("$blob" -split "`0" | Where-Object { $_ })
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
    if ($paths.Count -eq 0) { return }
    $useStdin = $prefixArguments -contains 'update-index' -or $prefixArguments -contains 'checkout-index'
    if ($useStdin) {
        $temp = Join-Path $env:TEMP ("ozdqp-hub-index-{0}.txt" -f [guid]::NewGuid().ToString('N'))
        try {
            $payload = [System.Text.Encoding]::UTF8.GetBytes((($paths -join "`0") + "`0"))
            [System.IO.File]::WriteAllBytes($temp, $payload)
            $argLine = (@('-C', $workspace, '-c', 'core.quotepath=false', '-c', 'i18n.filesEncoding=utf-8') + $prefixArguments + @('-z', '--stdin') | ForEach-Object {
                if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
            }) -join ' '
            $ran = cmd.exe /c "git $argLine < `"$temp`""
            if ($LASTEXITCODE -ne 0) { throw "git $($prefixArguments -join ' ') failed" }
            [void]$ran
        } finally {
            Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        }
        return
    }
    $chunkSize = 20
    for ($offset = 0; $offset -lt $paths.Count; $offset += $chunkSize) {
        $last = [Math]::Min($offset + $chunkSize - 1, $paths.Count - 1)
        $chunk = @($paths[$offset..$last])
        & git -C $workspace -c core.quotepath=false @prefixArguments -- @chunk
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
