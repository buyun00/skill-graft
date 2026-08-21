import type { AuditEvent } from '../contracts/index.js'
import type { LocalHostContext } from './host-context.js'
import type { RequestLedgerEntry, RequestLedgerPort } from '../application/ports.js'

type LedgerFile = {
  version: 1
  entries: RequestLedgerEntry[]
}

type AuditFile = {
  version: 1
  events: AuditEvent[]
}

type LegacyCombinedFile = LedgerFile & {
  events?: AuditEvent[]
}

const EMPTY_LEDGER: LedgerFile = { version: 1, entries: [] }
const EMPTY_AUDIT: AuditFile = { version: 1, events: [] }

function loadLedger(ctx: LocalHostContext, file: string): LegacyCombinedFile {
  const value = ctx.persist.readJson<LegacyCombinedFile>(file, EMPTY_LEDGER)
  if (value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error('unsupported application ledger format')
  }
  return value
}

function loadAudit(ctx: LocalHostContext, auditFile: string, legacy: LegacyCombinedFile): AuditFile {
  const fallback = legacy.events ? { version: 1 as const, events: legacy.events } : EMPTY_AUDIT
  const value = ctx.persist.readJson<AuditFile>(auditFile, fallback)
  if (value.version !== 1 || !Array.isArray(value.events)) {
    throw new Error('unsupported application audit format')
  }
  return value
}

export function createPersistentRequestLedger(ctx: LocalHostContext): RequestLedgerPort {
  const ledgerFile = ctx.path.join(ctx.hubRoot, 'skill-review', 'application-ledger.json')
  const auditFile = ctx.path.join(ctx.hubRoot, 'skill-review', 'application-audit.json')
  return {
    read(requestId) {
      return loadLedger(ctx, ledgerFile).entries.find((entry) => entry.requestId === requestId) || null
    },
    begin(entry) {
      const data = loadLedger(ctx, ledgerFile)
      if (data.entries.some((candidate) => candidate.requestId === entry.requestId)) {
        throw new Error('requestId was claimed by another application instance')
      }
      if (data.events && !ctx.fs.exists(auditFile)) {
        // Preserve P1 pre-split terminal events before rewriting the replay
        // ledger into its entries-only shape.
        ctx.persist.writeJson(auditFile, loadAudit(ctx, auditFile, data))
      }
      data.entries.push(entry)
      ctx.persist.writeJson(ledgerFile, { version: 1, entries: data.entries } satisfies LedgerFile)
    },
    complete(entry, inputEvents) {
      const events = Array.isArray(inputEvents) ? [...inputEvents] : [inputEvents]
      const terminal = events[events.length - 1]
      if (!terminal) throw new Error('request completion requires an audit event')
      const ledger = loadLedger(ctx, ledgerFile)
      const audit = loadAudit(ctx, auditFile, ledger)
      const index = ledger.entries.findIndex((candidate) => candidate.requestId === entry.requestId)
      if (index < 0) throw new Error('request ledger entry disappeared before completion')
      const current = ledger.entries[index]
      if (current.digest !== entry.digest || current.commandKind !== entry.commandKind) {
        throw new Error('request ledger entry changed before completion')
      }
      const priorEvents = audit.events.filter((candidate) => candidate.requestId === entry.requestId)
      if (current.status === 'completed') {
        if (!priorEvents.some((candidate) => candidate.type === 'command.succeeded' || candidate.type === 'command.failed')) {
          throw new Error('completed request is missing its terminal audit event')
        }
        return
      }
      if (priorEvents.some((prior) => !events.some((event) => event.id === prior.id))) {
        throw new Error('request already has different audit events')
      }
      const missing = events.filter((event) => !priorEvents.some((prior) => prior.id === event.id))
      if (missing.length > 0) {
        audit.events.push(...missing)
        // Persist the redacted terminal event before exposing a replayable
        // outcome. P2 adds a cross-process transaction around both files.
        ctx.persist.writeJson(auditFile, audit)
      }
      ledger.entries[index] = entry
      ctx.persist.writeJson(ledgerFile, { version: 1, entries: ledger.entries } satisfies LedgerFile)
    },
    listEvents(limit) {
      const ledger = loadLedger(ctx, ledgerFile)
      return loadAudit(ctx, auditFile, ledger).events.slice().sort((left, right) => right.at.localeCompare(left.at)).slice(0, limit)
    }
  }
}
