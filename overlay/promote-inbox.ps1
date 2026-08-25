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

# Deprecated v0 compatibility facade. Decision policy and every state, inbox,
# history, file, Git, link, and audit effect are owned by Application v1.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-SkillGraftCommand {
    $command = Get-Command -Name 'sg' -CommandType Application,ExternalScript -ErrorAction Stop |
        Select-Object -First 1
    if ($null -eq $command -or [string]::IsNullOrWhiteSpace([string]$command.Source)) {
        throw 'installed sg command was not found on PATH'
    }
    return [string]$command.Source
}

if ([string]::IsNullOrWhiteSpace($Id)) {
    throw 'Id must not be empty'
}

$arguments = @(
    'decide',
    '--id', $Id,
    '--action', $Action.ToLowerInvariant()
)
if (-not [string]::IsNullOrWhiteSpace($Note)) {
    $arguments += @('--note', $Note)
}
if (-not [string]::IsNullOrWhiteSpace($MergeTarget)) {
    $arguments += @('--merge-target', $MergeTarget)
}
$arguments += '--contract-v1'

$sg = Resolve-SkillGraftCommand
& $sg @arguments
$sgExitCode = $LASTEXITCODE
$sgSucceeded = $?

if ($null -eq $sgExitCode) {
    $sgExitCode = if ($sgSucceeded) { 0 } else { 1 }
}
exit ([int]$sgExitCode)
