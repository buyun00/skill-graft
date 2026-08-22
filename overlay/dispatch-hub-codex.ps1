[CmdletBinding()]
param()

# Deprecated v0 compatibility facade. Session creation, concurrency policy,
# analysis, and suggestion persistence are owned by Application contract v1.
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

$sg = Resolve-SkillGraftCommand
& $sg 'analyze' '--contract-v1'
$sgExitCode = $LASTEXITCODE
$sgSucceeded = $?

if ($null -eq $sgExitCode) {
    $sgExitCode = if ($sgSucceeded) { 0 } else { 1 }
}
exit ([int]$sgExitCode)
