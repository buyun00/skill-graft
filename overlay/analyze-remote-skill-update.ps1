[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GameRepo,
    [Parameter(Mandatory = $true)]
    [string]$HubRoot,
    [string]$OldCommit,
    [string]$NewCommit,
    [string]$RefName = 'refs/remotes/manual/test',
    [switch]$DryRun,
    [switch]$DispatchCodex
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HubLib.ps1')

$gameRepo = Get-NormalizedPath $GameRepo
$hubRoot = Get-NormalizedPath $HubRoot
$watchedPathspecs = @(
    ':(glob).agents/skills/**',
    ':(glob).codex/skills/**',
    ':(glob).claude/skills/**',
    'AGENTS.md',
    'CLAUDE.md'
)

function Test-ZeroObjectId([string]$value) { return $value -match '^0{40,64}$' }
function Test-GitCommit([string]$repo, [string]$commit) {
    & git -C $repo cat-file -e "$commit^{commit}" 2>$null
    return $LASTEXITCODE -eq 0
}

function Get-UnitInfo([string]$path) {
    $normalized = $path.Replace('\', '/')
    if ($normalized -match '^\.(agents|codex|claude)/skills/([^/]+)(?:/|$)') {
        $unit = ".$($Matches[1])/skills/$($Matches[2])"
        return [pscustomobject]@{ Key = $unit; Name = $Matches[2]; Prefix = $unit }
    }
    return [pscustomobject]@{ Key = $normalized; Name = [System.IO.Path]::GetFileName($normalized); Prefix = $normalized }
}

function Get-Transactions {
    if (-not [string]::IsNullOrWhiteSpace($OldCommit) -or -not [string]::IsNullOrWhiteSpace($NewCommit)) {
        return @([pscustomobject]@{ Old = $OldCommit; New = $NewCommit; Ref = $RefName })
    }
    $raw = [Console]::In.ReadToEnd()
    $list = [System.Collections.Generic.List[object]]::new()
    foreach ($line in ($raw -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line.Trim() -split '\s+', 3
        if ($parts.Count -ne 3) { continue }
        [void]$list.Add([pscustomobject]@{ Old = $parts[0]; New = $parts[1]; Ref = $parts[2] })
    }
    return @($list)
}

function Export-UnitFiles([string]$commit, [string]$prefix, [string]$destRoot) {
    $files = @(& git -C $gameRepo -c core.quotepath=false ls-tree -r --name-only $commit -- $prefix)
    if ($LASTEXITCODE -ne 0) { throw "git ls-tree failed for $prefix" }
    foreach ($file in $files) {
        $rel = $file.Substring($prefix.Length).TrimStart('/')
        if ([string]::IsNullOrWhiteSpace($rel)) { $rel = [System.IO.Path]::GetFileName($file) }
        $dest = Join-Path $destRoot ($rel.Replace('/', '\'))
        [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest))
        $content = & git -C $gameRepo show "${commit}:${file}"
        if ($LASTEXITCODE -ne 0) { continue }
        $text = if ($content -is [array]) { $content -join "`n" } else { [string]$content }
        [System.IO.File]::WriteAllText($dest, $text, [System.Text.UTF8Encoding]::new($false))
    }
}

$statePath = Join-Path $hubRoot 'skill-review\state.json'
$state = Read-JsonFile $statePath ([pscustomobject]@{ version = 1; lastIngest = $null; items = @() })
if ($null -eq $state.items) { $state | Add-Member items @() -Force }
$created = 0

foreach ($transaction in @(Get-Transactions)) {
    if (-not $transaction.Ref.StartsWith('refs/remotes/', [System.StringComparison]::OrdinalIgnoreCase) -and $RefName -notlike 'refs/remotes/*') {
        if ($transaction.Ref -notlike 'refs/remotes/*') { continue }
    }
    if (Test-ZeroObjectId $transaction.Old -or Test-ZeroObjectId $transaction.New) { continue }
    if (-not (Test-GitCommit $gameRepo $transaction.Old) -or -not (Test-GitCommit $gameRepo $transaction.New)) { continue }

    $args = @('-C', $gameRepo, '-c', 'core.quotepath=false', 'diff', '--name-status', '--find-renames', $transaction.Old, $transaction.New, '--') + $watchedPathspecs
    $diffLines = @(& git @args 2>$null)
    if ($LASTEXITCODE -ne 0 -or $diffLines.Count -eq 0) { continue }

    $units = @{}
    foreach ($line in $diffLines) {
        $parts = $line -split "`t"
        if ($parts.Count -lt 2) { continue }
        $status = $parts[0]
        $path = if ($status -match '^[RC]' -and $parts.Count -ge 3) { $parts[2] } else { $parts[1] }
        $info = Get-UnitInfo $path
        if (-not $units.ContainsKey($info.Key)) { $units[$info.Key] = $info }
    }

    foreach ($unit in $units.Values) {
        $id = [System.BitConverter]::ToString(
            [System.Security.Cryptography.SHA256]::Create().ComputeHash(
                [System.Text.Encoding]::UTF8.GetBytes("$($transaction.Ref)|$($transaction.New)|$($unit.Key)")
            )
        ).Replace('-', '').Substring(0, 16).ToLowerInvariant()
        if (@($state.items) | Where-Object { $_.id -eq $id }) { continue }
        $inboxRel = "skills/inbox/$($unit.Name)"
        $inboxAbs = Join-Path $hubRoot ($inboxRel.Replace('/', '\'))
        if (-not $DryRun) {
            if (Test-Path -LiteralPath $inboxAbs) { Remove-Item -LiteralPath $inboxAbs -Recurse -Force }
            [void](New-Item -ItemType Directory -Force -Path $inboxAbs)
            if ($unit.Prefix -match '/skills/') {
                Export-UnitFiles $transaction.New $unit.Prefix $inboxAbs
            } else {
                $text = & git -C $gameRepo show "$($transaction.New):$($unit.Prefix)" 2>$null
                if ($LASTEXITCODE -eq 0) {
                    $body = if ($text -is [array]) { $text -join "`n" } else { [string]$text }
                    [System.IO.File]::WriteAllText((Join-Path $inboxAbs ([System.IO.Path]::GetFileName($unit.Prefix))), $body, [System.Text.UTF8Encoding]::new($false))
                }
            }
        }
        $entry = [pscustomobject]@{
            id = $id
            name = $unit.Name
            unit = $unit.Key
            sourceRef = $transaction.Ref
            oldCommit = $transaction.Old
            newCommit = $transaction.New
            inboxPath = $inboxRel
            status = 'queued'
            suggestion = [pscustomobject]@{ action = ''; target = ''; reason = ''; confidence = '' }
            createdAt = [DateTimeOffset]::Now.ToString('o')
            updatedAt = [DateTimeOffset]::Now.ToString('o')
        }
        $state.items = @($state.items) + @($entry)
        $created++
    }
    $state.lastIngest = [pscustomobject]@{
        ref = $transaction.Ref
        old = $transaction.Old
        new = $transaction.New
        at = [DateTimeOffset]::Now.ToString('o')
        gameRepo = $gameRepo
    }
}

if (-not $DryRun) {
    Write-JsonFile $statePath $state
    if ($created -gt 0) {
        New-HistoryRecord $hubRoot @{ type = 'ingest'; count = $created; lastIngest = $state.lastIngest }
        if ($DispatchCodex) {
            & (Join-Path $PSScriptRoot 'dispatch-hub-codex.ps1')
        }
    }
}

Write-Output "Ingested $created skill unit(s) into $hubRoot"
