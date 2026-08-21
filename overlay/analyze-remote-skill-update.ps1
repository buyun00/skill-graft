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

# Deprecated v0 compatibility facade. Ingest policy and every state, inbox,
# history, file, Git, and session effect are owned by Application contract v1.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-LegacyPath([string]$Value, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "$Name must not be empty"
    }
    try {
        return [System.IO.Path]::GetFullPath($Value.Trim())
    } catch {
        throw "$Name is not a valid path"
    }
}

function Resolve-SkillGraftCommand {
    $command = Get-Command -Name 'sg' -CommandType Application,ExternalScript -ErrorAction Stop |
        Select-Object -First 1
    if ($null -eq $command -or [string]::IsNullOrWhiteSpace([string]$command.Source)) {
        throw 'installed sg command was not found on PATH'
    }
    return [string]$command.Source
}

$hasOldCommit = -not [string]::IsNullOrWhiteSpace($OldCommit)
$hasNewCommit = -not [string]::IsNullOrWhiteSpace($NewCommit)
if ($hasOldCommit -ne $hasNewCommit) {
    throw '-OldCommit and -NewCommit must be supplied together'
}
if ($hasOldCommit -and [string]::IsNullOrWhiteSpace($RefName)) {
    throw '-RefName must not be empty when an explicit transaction is supplied'
}

$gameRepoPath = Resolve-LegacyPath $GameRepo 'GameRepo'
$hubRootPath = Resolve-LegacyPath $HubRoot 'HubRoot'
$explicitPayload = if ($hasOldCommit) {
    "$($OldCommit.Trim()) $($NewCommit.Trim()) $($RefName.Trim())"
} else { $null }

$arguments = @('ingest', '--game-repo', $gameRepoPath)
if ($DispatchCodex) { $arguments += '--dispatch' }
if ($DryRun) { $arguments += '--dry-run' }
$arguments += '--contract-v1'

$sg = Resolve-SkillGraftCommand
$hadHubRoot = Test-Path -LiteralPath 'Env:HUB_ROOT'
$previousHubRoot = $env:HUB_ROOT
try {
    $env:HUB_ROOT = $hubRootPath
    if ($null -ne $explicitPayload) {
        $explicitPayload | & $sg @arguments
    } else {
        # Do not materialize or rewrite the hook stream in the facade. The
        # installed native sg process inherits redirected stdin byte-for-byte.
        & $sg @arguments
    }
    $sgExitCode = $LASTEXITCODE
    $sgSucceeded = $?
} finally {
    if ($hadHubRoot) {
        $env:HUB_ROOT = $previousHubRoot
    } else {
        Remove-Item -LiteralPath 'Env:HUB_ROOT' -ErrorAction SilentlyContinue
    }
}

if ($null -eq $sgExitCode) {
    $sgExitCode = if ($sgSucceeded) { 0 } else { 1 }
}
exit ([int]$sgExitCode)
