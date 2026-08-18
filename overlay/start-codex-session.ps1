[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('edit', 'attach', 'detach', 'analyze-note')]
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
if ($null -eq $state.sessions) { $state | Add-Member -NotePropertyName sessions -NotePropertyValue @() }

$prompt = switch ($Kind) {
    'edit' {
        if ([string]::IsNullOrWhiteSpace($Path)) { throw 'edit requires -Path' }
        @"
你在中心仓 $hubRoot 中工作。只改 ``$Path``。
面板意图：$Intent
不要写游戏仓业务代码。改完在本仓 git commit，并在 skill-review/history 记一条。
"@
    }
    'attach' {
        if ([string]::IsNullOrWhiteSpace($Worktree)) { throw 'attach requires -Worktree' }
        @"
你在中心仓 $hubRoot 工作，目标游戏 worktree 是 $Worktree（已通过 --add-dir 可写）。
任务：剥掉该树自带的官方 Skill 体系，改挂本中心仓本地体系。不要把跑一遍脚本当成完成。

固定步骤：
1. 侦察：分支、git status、官方 .agents/.claude/.codex/skills 是否在磁盘、是否已有 hub 链接、与 hub 的 3 Skill 是否内容冲突。
2. 先向用户汇报将剥哪些路径、将挂哪些链接、冲突怎么处理，等确认。
3. 确认后再调用 overlay/manage-skill-visibility.ps1 -Workspace '$Worktree' -Mode Disable，以及 overlay/attach-library.ps1 -TargetWorktree '$Worktree' -ConfigureGit。
4. 验收：官方树不在磁盘、3 Skill 与 AGENTS.override.md 指向 hub、游戏仓 git status 没有误删、该树能读到 hub 文件。
5. 写入 skill-review/history，确认 overlay/attached-worktrees.txt 含该路径。
有未提交改动、重名但内容不同、或验收失败：停手，不要 -Force。
"@
    }
    'detach' {
        if ([string]::IsNullOrWhiteSpace($Worktree)) { throw 'detach requires -Worktree' }
        @"
你在中心仓 $hubRoot 工作，目标游戏 worktree 是 $Worktree。
任务：拆掉 hub 链接并 Restore 官方 Skill 树。先侦察再动手，等用户确认。
可用 overlay/manage-skill-visibility.ps1 -Workspace '$Worktree' -Mode Restore。
不要删除用户未提交的业务改动。
"@
    }
    default { $Intent }
}

$addDir = @()
if (-not [string]::IsNullOrWhiteSpace($Worktree)) {
    $addDir = @('--add-dir', (Get-NormalizedPath $Worktree))
}

$id = [guid]::NewGuid().ToString('N').Substring(0, 12)
$quotedPrompt = $prompt.Replace('"', '`"')
$codexArgs = @('-C', $hubRoot) + $addDir + @('--', $quotedPrompt)
$argLine = ($codexArgs | ForEach-Object { if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ } }) -join ' '

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wt) {
    $proc = Start-Process -FilePath $wt.Source -ArgumentList @('new-tab', '--title', "ozdqp-skill-hub $Kind", '-d', $hubRoot, 'powershell', '-NoExit', '-Command', "codex $argLine") -PassThru
} else {
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit', '-Command', "Set-Location -LiteralPath '$hubRoot'; codex $argLine") -PassThru
}

$session = [pscustomobject]@{
    id = $id
    kind = $Kind
    path = $Path
    worktree = $Worktree
    intent = $Intent
    pid = $proc.Id
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
