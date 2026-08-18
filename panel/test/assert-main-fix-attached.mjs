import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const hubRoot = path.resolve(__dirname, '..', '..')
const worktree = 'E:\\ozdqp-main-fix'
const panelBase = 'http://127.0.0.1:18765'

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exitCode = 1
}

function pass(message) {
  console.log(`PASS ${message}`)
}

function assert(condition, message) {
  if (condition) pass(message)
  else fail(message)
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

const prompt = fs.readFileSync(path.join(hubRoot, 'overlay', 'prompts', 'attach.txt'), 'utf8')
assert(prompt.includes('-PreferLibrary'), 'attach prompt ships PreferLibrary')
assert(prompt.includes('不是停手：游戏仓有未提交的业务改动'), 'attach prompt does not stop on dirty game files')
assert(!/等确认/.test(prompt), 'attach prompt does not wait for a second confirmation')

const attached = fs.readFileSync(path.join(hubRoot, 'overlay', 'attached-worktrees.txt'), 'utf8')
assert(attached.split(/\r?\n/).some((line) => samePath(line.trim(), worktree)), 'attached-worktrees.txt lists main-fix')

const historyDir = path.join(hubRoot, 'skill-review', 'history')
const historyFiles = fs.readdirSync(historyDir).filter((name) => name.endsWith('.json'))
const historyHits = historyFiles.filter((name) => {
  const text = fs.readFileSync(path.join(historyDir, name), 'utf8')
  return text.includes('E:\\\\ozdqp-main-fix') && text.includes('worktree-attach')
})
assert(historyHits.length > 0, `history has worktree-attach for main-fix (${historyHits.join(',')})`)

const trees = await fetch(`${panelBase}/api/worktrees`).then((res) => {
  if (!res.ok) throw new Error(`worktrees ${res.status}`)
  return res.json()
})
const row = (trees.worktrees || []).find((item) => samePath(item.path, worktree))
assert(Boolean(row), 'GET /api/worktrees returns ozdqp-main-fix')
if (row) {
  assert(row.attached === true, `attached=true (got ${row.attached})`)
  assert(row.overrideLinked === true, `overrideLinked=true (got ${row.overrideLinked})`)
  assert(row.officialPresent === false, `officialPresent=false (got ${row.officialPresent})`)
}

const sessions = await fetch(`${panelBase}/api/codex/sessions`).then((res) => {
  if (!res.ok) throw new Error(`sessions ${res.status}`)
  return res.json()
})
const attach = (sessions.sessions || []).filter((item) => item.kind === 'attach' && item.worktree && samePath(item.worktree, worktree))
const done = attach.find((item) => item.status === 'waiting' && item.exitCode === 0 && String(item.lastMessage || '').includes('切换已经完成'))
  || attach.find((item) => item.status === 'waiting' && item.exitCode === 0)
assert(Boolean(done), 'panel has a successful attach session for main-fix')
if (done) {
  assert(done.status !== 'failed', `session ${done.id} is not failed`)
  const log = done.logFile && fs.existsSync(done.logFile) ? fs.readFileSync(done.logFile, 'utf8') : ''
  assert(log.includes("manage-skill-visibility.ps1' -Workspace 'E:\\\\ozdqp-main-fix' -Mode Disable")
    || log.includes('manage-skill-visibility.ps1') && log.includes('-Mode Disable'), 'session log ran Disable')
  assert(log.includes('-PreferLibrary'), 'session log ran attach-library with PreferLibrary')
}

if (process.exitCode) {
  console.error('assert-main-fix-attached failed')
  process.exit(process.exitCode)
}
console.log('assert-main-fix-attached ok')
