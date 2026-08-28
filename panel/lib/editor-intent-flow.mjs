// The editor loses focus before a focused button receives its click. Keep the
// blur save and the following confirmation as one serialized user intent.
// Render/input tokens still decide whether an old DOM callback is allowed to
// do anything; this queue only coordinates a current callback's ordering.
export function createEditorIntentQueue() {
  const saves = new Map()
  const confirmations = new Set()
  const confirmationPromises = new Map()
  // A blur can be delivered after the confirmation request has already
  // settled. Remember the successful confirmation for this render token so
  // that late blur cannot call draft/file again and reset confirmed=false.
  const completedConfirmations = new Map()

  function queueSave(fileId, inputToken, save) {
    const key = String(fileId || '')
    if (!key || typeof save !== 'function') return Promise.resolve(false)
    const existing = saves.get(key)
    if (existing?.inputToken === inputToken) return existing.promise
    if (completedConfirmations.get(key) === inputToken) return Promise.resolve(true)
    // Once the confirmation click has claimed this file, its payload owns the
    // current editor snapshot. A blur dispatched by the focus transition must
    // not start a second write (or overwrite the confirmation's snapshot).
    if (confirmations.has(key)) return Promise.resolve(true)
    let operation
    try {
      operation = Promise.resolve(save())
    } catch (error) {
      operation = Promise.reject(error)
    }
    const record = { inputToken, promise: operation }
    saves.set(key, record)
    void operation.then(() => {
      if (saves.get(key) === record) saves.delete(key)
    }, () => {
      if (saves.get(key) === record) saves.delete(key)
    })
    return operation
  }

  function pendingSave(fileId, inputToken) {
    const record = saves.get(String(fileId || ''))
    return record?.inputToken === inputToken ? record.promise : null
  }

  async function confirm(fileId, inputToken, options = {}) {
    const key = String(fileId || '')
    const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true
    const canStart = typeof options.canStart === 'function' ? options.canStart : () => true
    const persistConfirmation = options.confirm
    if (!key || typeof persistConfirmation !== 'function' || !isCurrent() || confirmations.has(key)) return false
    const pending = saves.get(key)
    if (!canStart() && (!pending || pending.inputToken !== inputToken)) return false
    confirmations.add(key)
    // Start on the next microtask after registering the promise, so a same
    // tick commit can await this confirmation instead of dropping its click
    // while the write gate is still settling.
    const operation = Promise.resolve().then(async () => {
      let snapshot
      try {
        snapshot = typeof options.snapshot === 'function' ? options.snapshot() : options.snapshot
      } catch {
        return false
      }
      let persisted = false
      if (pending?.inputToken === inputToken) {
        persisted = (await pending.promise) !== false
        if (!persisted || !isCurrent()) return false
      }
      if (!isCurrent() || !canStart()) return false
      return (await persistConfirmation({ persisted, snapshot })) !== false
    })
    confirmationPromises.set(key, operation)
    let result = false
    try {
      result = (await operation) !== false
      if (result) completedConfirmations.set(key, inputToken)
      return result
    } finally {
      confirmations.delete(key)
      if (confirmationPromises.get(key) === operation) confirmationPromises.delete(key)
    }
  }

  return {
    queueSave,
    releaseConfirmation(fileId, inputToken) {
      const key = String(fileId || '')
      if (completedConfirmations.get(key) === inputToken) completedConfirmations.delete(key)
      return true
    },
    pendingSave,
    confirm,
    pendingConfirmation: (fileId) => confirmationPromises.get(String(fileId || '')) || null,
    isConfirmPending: (fileId) => confirmations.has(String(fileId || '')),
  }
}

// A pointer click moves focus before its click event is dispatched. Prevent
// that focus transfer for the primary pointer so a blur-triggered save cannot
// disable the confirmation button between pointerdown and click. The click
// handler persists the current editor snapshot together with confirmation.
export function preserveConfirmClickOnPointerDown(event) {
  if (!event || typeof event.preventDefault !== 'function') return false
  if (event.button !== undefined && Number(event.button) !== 0) return false
  event.preventDefault()
  return true
}
