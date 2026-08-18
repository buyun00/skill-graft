[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Id,
    [Parameter(Mandatory = $true)]
    [ValidateSet('adopt', 'merge', 'reject')]
    [string]$Action,
    [string]$Note,
    [string]$MergeTarget
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HubLib.ps1')

$hubRoot = Get-HubRoot
$statePath = Join-Path $hubRoot 'skill-review\state.json'
$state = Read-JsonFile $statePath ([pscustomobject]@{ version = 1; items = @() })
$item = @($state.items) | Where-Object { $_.id -eq $Id } | Select-Object -First 1
if ($null -eq $item) { throw "Unknown inbox item: $Id" }

$inboxAbs = Join-Path $hubRoot ([string]$item.inboxPath).Replace('/', '\')
if ($Action -eq 'adopt') {
    $name = if ($item.name) { [string]$item.name } else { Split-Path -Leaf $inboxAbs }
    $dest = Join-Path $hubRoot "skills\adopted\$name"
    if (Test-Path -LiteralPath $dest) { throw "adopted already exists: $dest" }
    if (-not (Test-Path -LiteralPath $inboxAbs)) { throw "inbox missing: $inboxAbs" }
    [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest))
    Move-Item -LiteralPath $inboxAbs -Destination $dest
    $item.status = 'adopted'
    $item.adoptedPath = "skills/adopted/$name"
    $gameRepo = (& git -C $hubRoot config --get ozdqp.gameRepo 2>$null)
    if (-not [string]::IsNullOrWhiteSpace($gameRepo) -and (Test-HubListContains (Join-Path $hubRoot 'overlay\attached-worktrees.txt') $gameRepo)) {
        [void](New-HubDirectoryLink (Join-Path $gameRepo ".agents\skills\$name") $dest)
    }
} elseif ($Action -eq 'merge') {
    if ([string]::IsNullOrWhiteSpace($MergeTarget)) { throw 'merge requires -MergeTarget (hub-relative path)' }
    $targetAbs = Join-Path $hubRoot ($MergeTarget.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $targetAbs)) { throw "merge target missing: $MergeTarget" }
    $item.status = 'merged-into-3skill'
    $item.mergeTarget = $MergeTarget
    if (Test-Path -LiteralPath $inboxAbs) {
        Remove-Item -LiteralPath $inboxAbs -Recurse -Force
    }
} else {
    $item.status = 'rejected'
    if (Test-Path -LiteralPath $inboxAbs) {
        Remove-Item -LiteralPath $inboxAbs -Recurse -Force
    }
}

$item.updatedAt = [DateTimeOffset]::Now.ToString('o')
$item.note = $Note
Write-JsonFile $statePath $state
New-HistoryRecord $hubRoot @{
    type = 'decide'
    id = $Id
    action = $Action
    note = $Note
    mergeTarget = $MergeTarget
}

$commitMessage = "skill-hub: $Action $($item.name)"
& git -C $hubRoot add -- 'skills' 'skill-review'
& git -C $hubRoot commit -m $commitMessage 2>$null
Write-Output ($item | ConvertTo-Json -Depth 8)
