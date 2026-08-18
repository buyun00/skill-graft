[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HubLib.ps1')

$hubRoot = Get-HubRoot
$lockPath = Join-Path $hubRoot 'skill-review\hub-codex.lock'
if (Test-Path -LiteralPath $lockPath) {
    $existing = Get-Content -LiteralPath $lockPath -Raw -ErrorAction SilentlyContinue
    if ($existing -match 'pid=(\d+)') {
        $pidValue = [int]$Matches[1]
        $running = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
        if ($running) {
            Write-Output "Hub Codex analyze already running (pid $pidValue); queued only."
            return
        }
    }
}

$prompt = @'
你在中心仓工作。只读 skills/inbox 与 skills/ozdqp-*，只更新 skill-review/state.json 里 status=queued 的条目：
写成 proposed，填 suggestion.action（adopt|merge|reject）、suggestion.target、suggestion.reason、suggestion.confidence。
禁止修改 skills/ozdqp-* 和 skills/adopted。禁止写游戏仓。
'@

$proc = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    "Set-Location -LiteralPath '$hubRoot'; try { codex exec -C '$hubRoot' --sandbox workspace-write -- $(ConvertTo-Json $prompt -Compress) } finally { if (Test-Path -LiteralPath '$lockPath') { Remove-Item -LiteralPath '$lockPath' -Force } }"
)
[System.IO.File]::WriteAllText($lockPath, "pid=$($proc.Id)`nat=$([DateTimeOffset]::Now.ToString('o'))`n", [System.Text.UTF8Encoding]::new($false))
Write-Output "Started hidden codex exec pid=$($proc.Id)"
