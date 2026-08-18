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
$runnerFile = Join-Path $hubRoot ('skill-review\run-codex-{0}.ps1' -f $id)
$addDirLine = ''
if (-not [string]::IsNullOrWhiteSpace($Worktree)) {
    $addDirLine = "    --add-dir '$(Get-NormalizedPath $Worktree)' ``"
}

$runnerLines = @(
    'Set-StrictMode -Version Latest',
    '$ErrorActionPreference = ''Stop''',
    "Set-Location -LiteralPath '$hubRoot'",
    "Write-Host 'Starting Codex ($Kind) in $hubRoot'",
    "Get-Content -LiteralPath '$promptFile' -Raw -Encoding UTF8 | codex ``",
    "    -C '$hubRoot' ``"
)
if ($addDirLine) { $runnerLines += $addDirLine }
$runnerLines += '    -'
[System.IO.File]::WriteAllLines($runnerFile, $runnerLines, [System.Text.UTF8Encoding]::new($false))

$powershellExe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $powershellExe)) {
    $powershellExe = 'powershell.exe'
}
$proc = Start-Process -FilePath $powershellExe -WorkingDirectory $hubRoot -PassThru -ArgumentList @(
    '-NoExit',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $runnerFile
)

$session = [pscustomobject]@{
    id = $id
    kind = $Kind
    path = $Path
    worktree = $Worktree
    intent = $Intent
    pid = $proc.Id
    promptFile = $promptFile
    runnerFile = $runnerFile
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
