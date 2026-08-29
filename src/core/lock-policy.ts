import type { LockRecordV1 } from '../contracts/index.js'

export type LockOwnerProbeStatus = 'alive-owner' | 'dead' | 'pid-reused' | 'unknown'

export type LockReclaimFacts = {
  nowEpochMs: number
  processStatus: LockOwnerProbeStatus
}

export type LockReclaimDecision =
  | { reclaim: false; reason: 'lease-active'; retryAfterMs: number }
  | { reclaim: false; reason: 'owner-alive' }
  | { reclaim: false; reason: 'pid-reused-fail-closed' }
  | { reclaim: false; reason: 'owner-unknown-fail-closed' }
  | { reclaim: true; reason: 'expired-owner-dead' }

export type LockOwnerIdentity = Pick<
  LockRecordV1,
  'ownerToken' | 'hostId' | 'pid' | 'processIdentity'
>

export function evaluateLockReclaim(
  record: LockRecordV1,
  facts: LockReclaimFacts
): LockReclaimDecision {
  const leaseUntil = Date.parse(record.leaseUntil)
  if (!Number.isFinite(leaseUntil) || !Number.isFinite(facts.nowEpochMs)) {
    return { reclaim: false, reason: 'owner-unknown-fail-closed' }
  }
  if (facts.nowEpochMs < leaseUntil) {
    return {
      reclaim: false,
      reason: 'lease-active',
      retryAfterMs: Math.ceil(leaseUntil - facts.nowEpochMs)
    }
  }
  if (facts.processStatus === 'alive-owner') return { reclaim: false, reason: 'owner-alive' }
  if (facts.processStatus === 'pid-reused') return { reclaim: false, reason: 'pid-reused-fail-closed' }
  if (facts.processStatus === 'dead') return { reclaim: true, reason: 'expired-owner-dead' }
  return { reclaim: false, reason: 'owner-unknown-fail-closed' }
}

export function authorizeLockOwner(record: LockRecordV1, owner: LockOwnerIdentity): boolean {
  return record.ownerToken === owner.ownerToken
    && record.hostId === owner.hostId
    && record.pid === owner.pid
    && record.processIdentity === owner.processIdentity
}
