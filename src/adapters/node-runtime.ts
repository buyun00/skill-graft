import { createHash, randomUUID } from 'node:crypto'
import type { ClockPort, HashPort, IdPort } from './host-context.js'

export function createNodeClock(): ClockPort {
  return {
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now()
  }
}

export function createNodeIds(): IdPort {
  return {
    next: (scope) => `${scope}-${randomUUID()}`
  }
}

export function createNodeHash(): HashPort {
  return {
    sha256: (value) => createHash('sha256').update(value).digest('hex')
  }
}
