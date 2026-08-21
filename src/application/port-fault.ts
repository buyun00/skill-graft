import type { HubError, HubErrorCode } from '../contracts/index.js'

export const PORT_FAULT_REASONS = [
  'runner-unavailable',
  'resource-not-found',
  'invalid-request',
  'dirty-conflict',
  'external-link',
  'content-conflict',
  'state-version-unsupported',
  'request-in-progress',
  'unavailable'
] as const

export type PortFaultReason = (typeof PORT_FAULT_REASONS)[number]

export type PortFault = Readonly<{
  type: 'skill-graft.port-fault/v1'
  reason: PortFaultReason
}>

const REASONS = new Set<string>(PORT_FAULT_REASONS)

const MAPPINGS: Readonly<Record<PortFaultReason, {
  code: HubErrorCode
  message: string
  retryable: boolean
}>> = {
  'runner-unavailable': {
    code: 'RUNNER_UNAVAILABLE',
    message: 'session runner unavailable',
    retryable: true
  },
  'resource-not-found': {
    code: 'NOT_FOUND',
    message: 'requested resource was not found',
    retryable: false
  },
  'invalid-request': {
    code: 'INVALID_ARGUMENT',
    message: 'host rejected an invalid request',
    retryable: false
  },
  'dirty-conflict': {
    code: 'CONFLICT_DIRTY',
    message: 'host state changed before the operation could be applied',
    retryable: false
  },
  'external-link': {
    code: 'CONFLICT_EXTERNAL_LINK',
    message: 'a managed artifact points to an external location',
    retryable: false
  },
  'content-conflict': {
    code: 'CONFLICT_CONTENT',
    message: 'a managed artifact has conflicting content',
    retryable: false
  },
  'state-version-unsupported': {
    code: 'STATE_VERSION_UNSUPPORTED',
    message: 'host state version is unsupported',
    retryable: false
  },
  'request-in-progress': {
    code: 'REQUEST_IN_PROGRESS',
    message: 'request is already in progress',
    retryable: true
  },
  unavailable: {
    code: 'PORT_FAILURE',
    message: 'host operation failed',
    retryable: true
  }
}

export function portFault(reason: PortFaultReason): PortFault {
  return Object.freeze({ type: 'skill-graft.port-fault/v1', reason })
}

export function isPortFault(value: unknown): value is PortFault {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 2
    && record.type === 'skill-graft.port-fault/v1'
    && typeof record.reason === 'string'
    && REASONS.has(record.reason)
}

export function portFaultError(value: unknown): HubError | null {
  if (!isPortFault(value)) return null
  return { ...MAPPINGS[value.reason] }
}
