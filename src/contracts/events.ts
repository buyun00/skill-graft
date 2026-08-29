import type { JsonObject } from './common.js'
import type { HubCommandKind } from './commands.js'
import type { ContractVersion } from './version.js'

export const AUDIT_EVENT_TYPES = [
  'command.started',
  'command.succeeded',
  'command.failed',
  'worktree.claim-evaluated',
  'worktree.attach-requested',
  'inbox.ingested',
  'inbox.transitioned',
  'session.requested',
  'session.reaped',
  'state.changed',
  'worktree.claimed',
  'worktree.materialized',
  'worktree.legacy-migrated',
  'worktree.legacy-rolled-back'
] as const

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

export type AuditEvent = {
  eventVersion: ContractVersion
  id: string
  type: AuditEventType
  at: string
  requestId: string
  hostId: string
  transport: string
  commandKind: HubCommandKind
  outcome: 'started' | 'succeeded' | 'failed' | 'rejected'
  subject?: string
  details?: JsonObject
}
