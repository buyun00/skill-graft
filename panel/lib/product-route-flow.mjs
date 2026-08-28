function text(value) {
  return typeof value === 'string' ? value : ''
}

export function beginDraftSaveTransaction({ origin = '', flow = '', busy = '' } = {}) {
  return Object.freeze({
    origin: text(origin),
    flow: text(flow),
    busy: text(busy),
  })
}

/**
 * @param {{transaction?: {origin?: string, flow?: string, busy?: string} | null, draftOrigin?: string, flow?: string, busy?: string}} input
 */
export function resolveDraftSavePresentation(input = {}) {
  const { transaction = null, draftOrigin = '', flow = '', busy = '' } = input
  if (transaction) {
    return {
      origin: text(transaction.origin),
      flow: text(transaction.flow),
      busy: text(transaction.busy),
      active: true,
    }
  }
  return {
    origin: text(draftOrigin),
    flow: text(flow),
    busy: text(busy),
    active: false,
  }
}

export function screenForProductPath(pathname) {
  const path = text(pathname) || '/'
  const matches = (base) => path === base || path.startsWith(`${base}/`)
  if (path === '/') return 'home'
  if (path.startsWith('/setup/analysis')) return 'analysis'
  if (path.startsWith('/setup/results')) return 'analysis-results'
  if (path.startsWith('/setup/preview')) return 'init-preview'
  if (path.startsWith('/setup/success')) return 'init-success'
  if (path.startsWith('/setup')) return 'welcome'
  if (path.startsWith('/changes/compare')) return 'update-compare'
  if (path.startsWith('/changes/result')) return 'update-result'
  if (path.startsWith('/changes/success')) return 'update-success'
  if (path.startsWith('/changes')) return 'update-review'
  // `merged` starts with `merge`; resolve the terminal route first.
  if (matches('/workspaces/connect/merged')) return 'merge-success'
  if (matches('/workspaces/connect/merge')) return 'merge'
  if (path.startsWith('/workspaces/connect/taken-over')) return 'takeover-success'
  if (path.startsWith('/workspaces/connect/takeover')) return 'takeover'
  if (path.startsWith('/workspaces/connect/mode')) return 'connect-mode'
  if (path.startsWith('/workspaces/connect')) return 'connect-select'
  if (path.startsWith('/workspaces')) return 'workspaces'
  if (path.startsWith('/library')) return 'library'
  if (path.startsWith('/assistant')) return 'assistant'
  if (path.startsWith('/diagnostics')) return 'diagnostics'
  if (path.startsWith('/recovery')) return 'recovery'
  return 'home'
}

// A terminal receipt is the only durable authority for a result page.  The
// service uses `merged` for a workspace contribution and `committed` for a
// center-library-only edit.  Both carry the plan/version identity; only a
// workspace merge needs a workspace path.
export function authoritativeProductReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = text(value.status).toLowerCase()
  if (!['merged', 'committed'].includes(status) || !text(value.planId) || !text(value.versionId)) return null
  if (status === 'merged' && !text(value.workspacePath)) return null
  return value
}

export function retainAuthoritativeReceipt(previous, candidate) {
  const next = authoritativeProductReceipt(candidate)
  const prior = authoritativeProductReceipt(previous)
  if (!next) return prior
  if (!prior) return next
  const sameIdentity = ['planId', 'versionId', 'draftId'].every((key) => {
    const left = text(next[key])
    const right = text(prior[key])
    return !left || !right || left === right
  })
  if (!sameIdentity) return next
  // A lightweight route response may omit fileCount/workspacePath while a
  // version-local sidecar already has it. Merge same-result receipts without
  // allowing an empty response to erase the durable count or origin.
  return {
    ...prior,
    ...next,
    ...(next.fileCount === undefined || next.fileCount === null ? { fileCount: prior.fileCount } : {}),
    ...(text(next.origin) ? {} : prior.origin ? { origin: prior.origin } : {}),
    ...(text(next.workspacePath) ? {} : prior.workspacePath ? { workspacePath: prior.workspacePath } : {}),
  }
}

/**
 * @param {{origin?: string, receipt?: Record<string, unknown> | null, fileCount?: number}} input
 */
export function draftSaveSuccessPresentation({ origin = '', receipt = null, fileCount = 0 } = {}) {
  const authoritative = authoritativeProductReceipt(receipt)
  const receiptOrigin = text(authoritative?.origin)
  const receiptStatus = text(authoritative?.status).toLowerCase()
  const centerOnly = /^library-/u.test(text(origin))
    || /^library-/u.test(receiptOrigin)
    || (receiptStatus === 'committed' && !text(authoritative?.workspacePath))
  const receiptCount = Number(authoritative?.fileCount)
  const fallbackCount = Number(fileCount)
  return {
    centerOnly,
    eyebrow: centerOnly ? '中心库已保存' : '更新已合并',
    title: centerOnly ? '中心库已保存这次修改' : '新的中心库版本已保存',
    subtitle: centerOnly
      ? '已生成新的中心库版本；原版本保持可回滚。'
      : '已生成新的中心库版本；原工作区和历史版本仍可回看。',
    fileCount: Number.isFinite(receiptCount) ? receiptCount : Number.isFinite(fallbackCount) ? fallbackCount : 0,
  }
}

export function isAiEditableFile(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && value.deleted !== true
    && value.editable !== false)
}

export function aiEditableFileIds(files = []) {
  return Array.isArray(files)
    ? files.filter(isAiEditableFile).map((file) => text(file.id)).filter(Boolean)
    : []
}

export function resolveProductRoute(pathname, state = {}) {
  const screen = screenForProductPath(pathname)
  const receipt = [state.mergeReceipt, state.commitReceipt, state.productReceipt]
    .map((candidate) => authoritativeProductReceipt(candidate))
    .find(Boolean) || null
  const receiptStatus = text(receipt?.status).toLowerCase()
  if (screen === 'merge-success') return receiptStatus === 'merged' ? { screen, receipt } : { screen: 'home', receipt: null }
  if (screen === 'merge') {
    if (receiptStatus === 'merged') return { screen: 'merge-success', receipt }
    return state.activeConnection === true ? { screen, receipt: null } : { screen: 'home', receipt: null }
  }
  if (screen === 'update-success' || screen === 'update-result') {
    return receipt ? { screen: 'update-success', receipt } : { screen: 'home', receipt: null }
  }
  return { screen, receipt: null }
}
