[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetWorktree
)

& (Join-Path $PSScriptRoot 'attach-library.ps1') -TargetWorktree $TargetWorktree
