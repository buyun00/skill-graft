let fallbackSequence = 0

function fallbackRequestId(kind) {
  fallbackSequence += 1
  return `panel-${kind}-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`
}

export function createMutationRetryRegistry(options = {}) {
  const createRequestId = options.createRequestId || fallbackRequestId
  const pending = new Map()

  return {
    requestId(key, fingerprint, kind = key) {
      const current = pending.get(key)
      if (current && current.fingerprint === fingerprint) return current.requestId
      const requestId = createRequestId(kind)
      pending.set(key, { fingerprint, requestId })
      return requestId
    },
    clear(key, fingerprint) {
      if (!pending.has(key)) return
      if (fingerprint !== undefined && pending.get(key).fingerprint !== fingerprint) return
      pending.delete(key)
    },
    clearAll() {
      pending.clear()
    },
    inspect(key) {
      const current = pending.get(key)
      return current ? { ...current } : null
    }
  }
}
