[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('edit', 'attach', 'detach', 'analyze-note', 'chat')]
    [string]$Kind,
    [string]$Path,
    [string]$Intent,
    [string]$Worktree
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HubLib.ps1')

$hubRoot = Get-HubRoot
$sessionsPath = Join-Path $hubRoot 'skill-review\sessions.json'
$state = Read-JsonFile $sessionsPath ([pscustomobject]@{ sessions = @() })
if ($null -eq $state.sessions) {
    $state | Add-Member -NotePropertyName sessions -NotePropertyValue @()
}

if ($Kind -eq 'edit' -and [string]::IsNullOrWhiteSpace($Path)) {
    throw 'edit requires -Path'
}
if (($Kind -eq 'attach' -or $Kind -eq 'detach') -and [string]::IsNullOrWhiteSpace($Worktree)) {
    throw "$Kind requires -Worktree"
}

$templateName = $Kind
if ($Kind -eq 'analyze-note') { $templateName = 'chat' }
$templatePath = Join-Path $PSScriptRoot ("prompts\$templateName.txt")
if (-not (Test-Path -LiteralPath $templatePath)) {
    throw "Missing prompt template: $templatePath"
}

$prompt = [System.IO.File]::ReadAllText($templatePath, [System.Text.UTF8Encoding]::new($false))
$prompt = $prompt.Replace('{{HUB}}', [string]$hubRoot)
$prompt = $prompt.Replace('{{PATH}}', [string]$Path)
$prompt = $prompt.Replace('{{INTENT}}', [string]$Intent)
$prompt = $prompt.Replace('{{WORKTREE}}', [string]$Worktree)
if ([string]::IsNullOrWhiteSpace($prompt)) {
    $prompt = [string]$Intent
}

$promptFile = Join-Path $hubRoot ('skill-review\prompt-{0}.txt' -f [guid]::NewGuid().ToString('N'))
[System.IO.File]::WriteAllText($promptFile, $prompt, [System.Text.UTF8Encoding]::new($false))

$id = [guid]::NewGuid().ToString('N').Substring(0, 12)
$codexCmd = "Get-Content -LiteralPath '$promptFile' -Raw -Encoding UTF8 | codex -C '$hubRoot'"
if (-not [string]::IsNullOrWhiteSpace($Worktree)) {
    $codexCmd += " --add-dir '$(Get-NormalizedPath $Worktree)'"
}

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wt) {
    $proc = Start-Process -FilePath $wt.Source -PassThru -ArgumentList @(
        'new-tab', '--title', "ozdqp-skill-hub $Kind", '-d', $hubRoot,
        'powershell', '-NoExit', '-Command', $codexCmd
    )
} else {
    $proc = Start-Process -FilePath 'powershell.exe' -PassThru -ArgumentList @(
        '-NoExit', '-Command', "Set-Location -LiteralPath '$hubRoot'; $codexCmd"
    )
}

$session = [pscustomobject]@{
    id = $id
    kind = $Kind
    path = $Path
    worktree = $Worktree
    intent = $Intent
    pid = $proc.Id
    promptFile = $promptFile
    startedAt = [DateTimeOffset]::Now.ToString('o')
    status = 'running'
}
$state.sessions = @($state.sessions) + @($session)
Write-JsonFile $sessionsPath $state
New-HistoryRecord $hubRoot @{
    type = 'codex-session'
    kind = $Kind
    path = $Path
    worktree = $Worktree
    sessionId = $id
    pid = $proc.Id
}
Write-Output ($session | ConvertTo-Json -Compress)
