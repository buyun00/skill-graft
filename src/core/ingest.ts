import { createHash } from 'node:crypto'
import type { HubContext } from './ports.js'
import type { HubStateFile, InboxItem, IngestTransaction } from './types.js'

export function parseIngestTransactions(text: string): IngestTransaction[] {
  const rows: IngestTransaction[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    rows.push({ old: parts[0], next: parts[1], ref: parts.slice(2).join(' ') })
  }
  return rows
}

export function emptyIngestResult() {
  return { ok: true, action: 'ingest' as const, created: 0, items: [] as InboxItem[], dispatched: false }
}

const WATCHED = ['.agents/skills', '.codex/skills', '.claude/skills', 'AGENTS.md', 'CLAUDE.md']

function isZeroOid(value: string) {
  return /^0{40,64}$/.test(value)
}

function commitExists(ctx: HubContext, repo: string, commit: string) {
  if (!commit || isZeroOid(commit)) return false
  return Boolean(ctx.git.output(repo, ['rev-parse', '--verify', `${commit}^{commit}`]).trim())
}

function unitInfo(pathText: string): { key: string; name: string; prefix: string; isSkill: boolean } {
  const normalized = pathText.replaceAll('\\', '/')
  const match = normalized.match(/^\.(agents|codex|claude)\/skills\/([^/]+)(?:\/|$)/)
  if (match) {
    const prefix = `.${match[1]}/skills/${match[2]}`
    return { key: prefix, name: match[2], prefix, isSkill: true }
  }
  const name = normalized.split('/').pop() || normalized
  return { key: normalized, name, prefix: normalized, isSkill: false }
}

function ingestId(ref: string, next: string, unitKey: string) {
  return createHash('sha256').update(`${ref}|${next}|${unitKey}`).digest('hex').slice(0, 16)
}

function changedPaths(ctx: HubContext, repo: string, oldCommit: string, next: string): string[] {
  const text = ctx.git.output(repo, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-status',
    '--find-renames',
    oldCommit,
    next,
    '--',
    ...WATCHED
  ])
  const paths: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const status = parts[0]
    const filePath = status.startsWith('R') || status.startsWith('C') ? parts[parts.length - 1] : parts[1]
    if (filePath) paths.push(filePath.replaceAll('\\', '/'))
  }
  return paths
}

function exportPrefix(ctx: HubContext, repo: string, commit: string, prefix: string, destRoot: string) {
  const files = ctx.git
    .output(repo, ['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', commit, '--', prefix])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const file of files) {
    const rel = file.slice(prefix.length).replace(/^[/\\]+/, '') || ctx.path.basename(file)
    const dest = ctx.path.join(destRoot, ...rel.split('/'))
    const body = ctx.git.output(repo, ['show', `${commit}:${file}`])
    ctx.fs.writeText(dest, body)
  }
}

export function ingest(
  ctx: HubContext,
  input: { gameRepo?: string | null; payload: string; dispatch?: boolean }
) {
  const rows = parseIngestTransactions(input.payload)
  if (rows.length === 0) return emptyIngestResult()
  const gameRepo = input.gameRepo || ''
  if (!gameRepo) throw new Error('ingest requires --game-repo or git config ozdqp.gameRepo')

  const stateFile = ctx.path.join(ctx.hubRoot, 'skill-review', 'state.json')
  const state: HubStateFile = ctx.persist.readState(stateFile)
  const items = Array.isArray(state.items) ? [...state.items] : []
  const createdItems: InboxItem[] = []

  for (const row of rows) {
    if (!row.ref.toLowerCase().startsWith('refs/remotes/')) continue
    if (isZeroOid(row.old) || isZeroOid(row.next)) continue
    if (!commitExists(ctx, gameRepo, row.old) || !commitExists(ctx, gameRepo, row.next)) continue

    const units = new Map<string, ReturnType<typeof unitInfo>>()
    for (const changed of changedPaths(ctx, gameRepo, row.old, row.next)) {
      const info = unitInfo(changed)
      if (!units.has(info.key)) units.set(info.key, info)
    }

    for (const unit of units.values()) {
      const id = ingestId(row.ref, row.next, unit.key)
      if (items.some((item) => item.id === id)) continue
      const inboxRel = `skills/inbox/${unit.name}`
      const inboxAbs = ctx.path.join(ctx.hubRoot, 'skills', 'inbox', unit.name)
      if (ctx.fs.exists(inboxAbs)) ctx.fs.remove(inboxAbs)
      ctx.fs.mkdirp(inboxAbs)
      if (unit.isSkill) exportPrefix(ctx, gameRepo, row.next, unit.prefix, inboxAbs)
      else {
        const body = ctx.git.output(gameRepo, ['show', `${row.next}:${unit.prefix}`])
        ctx.fs.writeText(ctx.path.join(inboxAbs, unit.name), body)
      }
      const now = new Date().toISOString()
      const item: InboxItem = {
        id,
        name: unit.name,
        unit: unit.key,
        status: 'queued',
        sourceRef: row.ref,
        oldCommit: row.old,
        newCommit: row.next,
        inboxPath: inboxRel,
        createdAt: now,
        updatedAt: now,
        suggestion: { action: '', target: '', reason: '', confidence: '' }
      }
      items.push(item)
      createdItems.push(item)
    }

    state.lastIngest = { ref: row.ref, old: row.old, new: row.next, gameRepo }
  }

  state.items = items
  ctx.persist.writeState(stateFile, state)
  if (createdItems.length > 0) {
    ctx.persist.writeJson(ctx.path.join(ctx.hubRoot, 'skill-review', 'history', `${Date.now().toString(36)}-ingest.json`), {
      type: 'ingest',
      count: createdItems.length,
      lastIngest: state.lastIngest
    })
  }

  return {
    ok: true,
    action: 'ingest' as const,
    gameRepo,
    created: createdItems.length,
    items: createdItems,
    dispatched: false
  }
}
