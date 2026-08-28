import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createPanelApi } from '../panel/lib/api.mjs'
import {
  createAiComposerStateMachine,
  createAiInstructionState,
  createAiRequestGate,
  canMutateProductInput,
  canNavigateProduct,
  isAiComposerLocked,
  resetAiFileSelection,
  shouldShowAiCancel,
  transitionAiInstructionScope,
} from '../panel/lib/ai-flow.mjs'
import { analysisRecoveryRoute, analysisViewMode, normalizedAnalysisRetryPath } from '../panel/lib/analysis-flow.mjs'
import { completeLibraryDraft, isLibraryDraftOrigin, startNewLibraryDraft } from '../panel/lib/library-draft-flow.mjs'
import { invalidateLibraryDetail, preferredLibraryFile } from '../panel/lib/library-detail-flow.mjs'
import { acceptManualWorkspacePath } from '../panel/lib/manual-path-flow.mjs'
import { createEditorIntentQueue, preserveConfirmClickOnPointerDown } from '../panel/lib/editor-intent-flow.mjs'
import { formatProductError } from '../panel/lib/product-errors.mjs'
import {
  beginDraftSaveTransaction,
  aiEditableFileIds,
  draftSaveSuccessPresentation,
  isAiEditableFile,
  retainAuthoritativeReceipt,
  resolveDraftSavePresentation,
  resolveProductRoute,
} from '../panel/lib/product-route-flow.mjs'
import { workspaceRecheckPresentation } from '../panel/lib/recheck-flow.mjs'
import { resolvePersistedSelectionReference } from '../panel/lib/selection-flow.mjs'
import { preserveApprovedTakeoverPreview } from '../panel/lib/takeover-flow.mjs'
import { takeoverSummaryModel } from '../panel/lib/takeover-summary-flow.mjs'

const root = path.resolve(process.cwd())
const app = fs.readFileSync(path.join(root, 'panel', 'src', 'components', 'ProductApp.tsx'), 'utf8')
const api = fs.readFileSync(path.join(root, 'panel', 'lib', 'api.mjs'), 'utf8')
const editorFlow = fs.readFileSync(path.join(root, 'panel', 'lib', 'editor-intent-flow.mjs'), 'utf8')
const errors = fs.readFileSync(path.join(root, 'panel', 'lib', 'product-errors.mjs'), 'utf8')
const css = fs.readFileSync(path.join(root, 'panel', 'src', 'app', 'product.css'), 'utf8')

function cssDeclarations(selector) {
  const declarations = {}
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = match[1].trim().split(',').map((value) => value.trim())
    if (!selectors.includes(selector)) continue
    for (const declaration of match[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/gu)) declarations[declaration[1]] = declaration[2].trim()
  }
  return declarations
}

test('product panel keeps the corrected safe paths and user-facing controls wired', () => {
  for (const token of [
    'pickerRequestRef', 'formatProductError', 'data-testid="manual-workspace-path"',
    'initAcknowledged', 'acknowledgeProtection: true', 'createLibraryDraft',
    'data-testid="new-library-file-path"', 'data-testid="library-file-ai"', 'data-testid="merge-file-checkbox"',
    'data-testid="merge-ai-composer"', 'baselineVersion', 'center-only',
    'baselineSignature', 'selectedSystemRefs', 'renderMergeV2()', 'renderTakeoverV2()',
    'takeover-target-projection', 'targetOptions',
    'cancelAi', 'chatCancel', 'requestId', 'createAiRequestGate', 'request.controller?.signal', 'librarySource', 'filePath', '查看来源', '查看正文',
    'filteredLibraryFiles', 'library-file-search-results', 'manual-review-update',
    'system-blocked', 'sample-path-details', 'deletion-tombstone', 'rollbackPreview',
    'rollback-preview', 'confirm-rollback', 'targetProjection', 'canonicalTarget',
    'selectionNeedsReview', 'selectionConfirmed', 'safety-evidence', 'completeConnection',
    'resetAiForNewFlow', 'setScopedAiFiles', 'aiProcessing', 'aiCancellable', 'aiCancelVisible',
    'analysisFailure', 'analysis-failed', 'retry-analysis', 'originalContentAvailable',
    'preserveApprovedTakeoverPreview', 'selectionConfirmed: scopeSelectionConfirmed',
    'manualPathOpen', 'open={manualPathOpen}', 'setManualPathOpen(false)',
    'workspaceRecheck', 'aria-busy={workspaceRecheck.ariaBusy}', 'checkConnectedWorkspace',
    '规范目标目录', '实际写入路径（高级诊断）', 'canonicalTargetDirectory',
    'aiCancelSettling', 'setAiCancelSettling', 'canNavigateNow', 'writeBusyRef',
    'readOnly={!canMutateProductInputNow()}', 'beginCancelSettlement', 'inputToken',
    'aiInputToken', 'chatInputToken', 'setChatDraftFromUser', 'canEditChatInput',
    'setMergeSelection', 'settleChatCancellation', 'recoverFailedCancellation',
    'aiInputLockRef', 'comparisonRef', 'normalizeReceiptForOrigin', 'originalContent = file.originalContent',
    'await refreshLibrary(receiptQuery)', 'const response = dict(await api.draftConfirm(body))',
    'releaseConfirmation',
  ]) {
    assert.match(app, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), `missing panel contract: ${token}`)
  }
  assert.match(editorFlow, /completedConfirmations/u)
  assert.match(app, /function capabilitySystemName\(/u)
  assert.match(app, /return "项目技能体系"/u)
  assert.match(app, /return "项目工具能力"/u)
  assert.match(api, /search: \(query = ''\)/u)
  assert.match(api, /librarySource:\s*\(input = \{\}\)/u)
  assert.match(api, /chatCancel:\s*\(input = \{\}/u)
  assert.match(api, /rollbackPreview: \(input = \{\}\)/u)
  const aiComposerLines = app.split('\n').filter((line) => line.includes('<textarea') && line.includes('ai-composer'))
  assert.equal(aiComposerLines.length, 3, 'update compare, merge, and result must expose exactly three AI composers')
  assert.ok(aiComposerLines.every((line) => line.includes('readOnly={aiComposerLocked}')), 'all AI composers must lock at the same running boundary')
  assert.match(app, /const snapshot = request\.snapshot/u)
  assert.match(app, /aiRequestGateRef\.current\.isLocked\(\)/u)
  for (const handler of ['saveFile', 'confirmFile', 'commitUpdate']) {
    const start = app.indexOf(`const ${handler}`)
    const end = app.indexOf('\n  const ', start + 1)
    assert.ok(start >= 0 && end > start, `missing result handler: ${handler}`)
    assert.match(app.slice(start, end), /canMutateProductInputNow\(\)/u, `${handler} must fail closed synchronously`)
  }
  const scopeHandlerStart = app.indexOf('const setScopedAiFiles')
  const scopeHandlerEnd = app.indexOf('\n  const ', scopeHandlerStart + 1)
  assert.match(app.slice(scopeHandlerStart, scopeHandlerEnd), /canMutateProductInputNow\(\)\) return false/u)
  assert.match(app, /setAiPrompt\(event\.target\.value, aiInputToken\)/u)
  assert.match(app, /setResultPrompt\(event\.target\.value, aiInputToken\)/u)
  const mergeSelectionStart = app.indexOf('const setMergeSelection')
  const mergeSelectionEnd = app.indexOf('\n  const ', mergeSelectionStart + 1)
  assert.match(app.slice(mergeSelectionStart, mergeSelectionEnd), /canMutateProductInputNow\(\)\) return false/u)
  const mergeDraftStart = app.indexOf('const createMergeDraft')
  const mergeDraftEnd = app.indexOf('\n  const ', mergeDraftStart + 1)
  assert.match(app.slice(mergeDraftStart, mergeDraftEnd), /canMutateProductInputNow\(\)/u)
  const mergeV2Start = app.indexOf('const renderMergeV2')
  const mergeV2End = app.indexOf('\n  const renderMergeSuccess', mergeV2Start + 1)
  const mergeV2 = app.slice(mergeV2Start, mergeV2End)
  assert.match(mergeV2, /setMergeSelection/u)
  assert.doesNotMatch(mergeV2, /onChange=\{\(event\) => setMergeSelectedFiles/u)
  assert.match(mergeV2, /setMergeNote\(event\.target\.value, aiInputToken\)/u)
  assert.match(mergeV2, /readOnly=\{!canMutateProductInputNow\(\)\}/u)
  assert.match(mergeV2, /disabled=\{!canMutateProductInputNow\(\)\}/u)
  const editableFileStart = app.indexOf('const renderEditableFile')
  const editableFileEnd = app.indexOf('\n  const renderUpdateResult', editableFileStart + 1)
  const editableFile = app.slice(editableFileStart, editableFileEnd)
  assert.match(editableFile, /const inputToken = aiInputToken/u)
  assert.match(editableFile, /inputToken !== aiRequestGateRef\.current\.inputToken\(\)/u)
  const libraryDraftStart = app.indexOf('const createLibraryDraft')
  const libraryDraftEnd = app.indexOf('\n  const processAi', libraryDraftStart + 1)
  const libraryDraft = app.slice(libraryDraftStart, libraryDraftEnd)
  assert.match(libraryDraft, /canMutateProductInputNow\(\)/u)
  assert.match(libraryDraft, /writeBusyRef\.current = true[\s\S]*?if \(!await resetAiForNewFlow/u)
  for (const handler of ['initializeLibrary', 'completeConnection', 'applyTakeover', 'rollbackTakeover', 'confirmRollback', 'createMergeDraft', 'createLibraryDraft', 'confirmFile', 'commitUpdate']) {
    const start = app.indexOf(`const ${handler}`)
    const end = app.indexOf('\n  const ', start + 1)
    assert.ok(start >= 0 && end > start, `missing guarded write entry: ${handler}`)
    const source = app.slice(start, end)
    assert.match(source, /inputToken = aiInputToken/u, `${handler} must capture a render input token`)
    assert.match(source, /inputToken !== aiRequestGateRef\.current\.inputToken\(\)/u, `${handler} must reject stale render callbacks`)
    assert.match(source, /writeBusyRef\.current = true/u, `${handler} must reserve the write gate synchronously`)
    assert.match(source, /finally \{[\s\S]*writeBusyRef\.current = false/u, `${handler} must release the write gate in finally`)
  }
  for (const call of [
    'initializeLibrary(aiInputToken)', 'completeConnection(aiInputToken)', 'applyTakeover(aiInputToken)',
    'rollbackTakeover(aiInputToken)', 'confirmRollback(aiInputToken)', 'createMergeDraft(aiInputToken)',
    'confirmFile(file.id, aiInputToken)', 'commitUpdate(aiInputToken)',
  ]) assert.match(app, new RegExp(call.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), `missing render-token write call: ${call}`)
  assert.match(app, /setChatDraftFromUser\(event\.target\.value, chatInputToken\)/u)
  assert.match(app, /value=\{chatDraft\} readOnly=\{!canEditChatInput\(\)\} disabled=\{!canEditChatInput\(\)\}/u)
  assert.doesNotMatch(app, /setChatDraft\(event\.target\.value\)/u, 'chat inputs must not bypass the guarded setter')
  const resetStart = app.indexOf('const resetAiForNewFlow')
  const resetEnd = app.indexOf('\n  const setScopedAiFiles', resetStart + 1)
  assert.match(app.slice(resetStart, resetEnd), /failCancelSettlement[\s\S]*setAiProcessing\(false\)[\s\S]*setAiCancellable\(false\)/u)
  const cancelStart = app.indexOf('const cancelAi =')
  const cancelEnd = app.indexOf('\n  const saveFile', cancelStart + 1)
  assert.match(app.slice(cancelStart, cancelEnd), /failCancelSettlement[\s\S]*setAiProcessing\(false\)[\s\S]*setAiCancellable\(false\)/u)
  assert.match(app, /const canNavigateNow[\s\S]*busyRef\.current[\s\S]*chatRequestGateRef\.current\.isLocked\(\)/u)
  assert.match(app, /navigate\("update-result", false, "ai-success"\)/u)
  assert.match(app, /navigate\(overview\?\.initialized \? "home" : "welcome", false, "cancel"\)/u)
  assert.doesNotMatch(app, /request\.(?:filePaths|comparisonId|planId|workspacePath)\s*=/u, 'request metadata must be supplied at gate.begin, not assigned after it')
  for (const token of ['PRODUCT_PICKER_TIMEOUT', 'PRODUCT_TAKEOVER_UNSUPPORTED', 'PRODUCT_TAKEOVER_TOPOLOGY_CONFLICT', 'PRODUCT_ROLLBACK_TOPOLOGY_CONFLICT', 'PRODUCT_EXTERNAL_LINK', 'PRODUCT_SYSTEM_SELECTION_REQUIRED', 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE', 'PRODUCT_FILE_SELECTION_REQUIRED', 'PANEL_INVALID_ENVELOPE']) {
  assert.match(errors, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), `missing error fallback: ${token}`)
  }
  assert.doesNotMatch(app, /将写入工作区内的规范目标：\$\{selectedTarget\.targetPath\}/u, 'the operation file must not be presented as the canonical target root')
})

test('focused editor confirmation persists the blur save before the first confirmation and rejects a double click', async () => {
  const queue = createEditorIntentQueue()
  let releaseSave
  let busy = true
  let saveCount = 0
  let confirmCount = 0
  let persisted = false
  const saveFinished = new Promise((resolve) => { releaseSave = resolve })
  queue.queueSave('file-a', 'render-a', async () => {
    await saveFinished
    saveCount += 1
    busy = false
    return true
  })

  let settled = false
  const first = queue.confirm('file-a', 'render-a', {
    isCurrent: () => true,
    canStart: () => !busy,
    confirm: async (state) => {
      confirmCount += 1
      persisted = state.persisted
      return true
    },
  }).then((value) => {
    settled = true
    return value
  })
  await Promise.resolve()
  assert.equal(settled, false, 'confirmation must wait for the focused textarea blur save')
  assert.equal(await queue.confirm('file-a', 'render-a', { confirm: async () => true }), false, 'a second click must be ignored while the first intent is queued')

  releaseSave()
  assert.equal(await first, true)
  assert.equal(saveCount, 1)
  assert.equal(confirmCount, 1)
  assert.equal(persisted, true)

  const stale = await queue.confirm('file-a', 'old-render', { isCurrent: () => false, confirm: async () => true })
  assert.equal(stale, false, 'an old render callback must remain fail-closed')
})

test('a focused textarea keeps the first real pointer click alive so that one click saves current content and confirms', async () => {
  let prevented = false
  const accepted = preserveConfirmClickOnPointerDown({
    button: 0,
    preventDefault() { prevented = true },
  })
  assert.equal(accepted, true)
  assert.equal(prevented, true, 'pointer down must keep focus so blur cannot disable the button before click')

  const queue = createEditorIntentQueue()
  const writes = []
  const content = '# edited while focused\n'
  const confirmed = await queue.confirm('file-a', 'render-a', {
    isCurrent: () => true,
    canStart: () => true,
    confirm: async () => {
      writes.push({ content, confirmed: true })
      return true
    },
  })
  assert.equal(confirmed, true)
  assert.deepEqual(writes, [{ content, confirmed: true }])
})

test('focused confirmation atomically snapshots the latest textarea and owns a late blur save', async () => {
  const queue = createEditorIntentQueue()
  let latestContent = '# latest marker\n'
  let savedAfterClick = 0
  let confirmedSnapshot = null

  const confirmation = queue.confirm('file-a', 'render-a', {
    isCurrent: () => true,
    canStart: () => true,
    snapshot: () => latestContent,
    confirm: async ({ snapshot }) => {
      confirmedSnapshot = snapshot
      return true
    },
  })
  const lateBlur = queue.queueSave('file-a', 'render-a', () => {
    savedAfterClick += 1
    return true
  })

  assert.equal(await confirmation, true)
  assert.equal(await lateBlur, true)
  assert.equal(confirmedSnapshot, latestContent, 'the confirmation must carry the current textarea snapshot')
  assert.equal(savedAfterClick, 0, 'a blur save arriving during confirmation must not race the atomic write')
})

test('a blur arriving after confirmation settles cannot reset the confirmed draft', async () => {
  const queue = createEditorIntentQueue()
  let saveCount = 0
  const confirmed = await queue.confirm('file-a', 'render-a', {
    isCurrent: () => true,
    canStart: () => true,
    snapshot: () => '# focused marker\n',
    confirm: async () => true,
  })
  assert.equal(confirmed, true)
  assert.equal(await queue.queueSave('file-a', 'render-a', () => { saveCount += 1; return true }), true)
  assert.equal(saveCount, 0, 'late blur must be absorbed after the atomic confirmation')
  queue.releaseConfirmation('file-a', 'render-a')
  assert.equal(await queue.queueSave('file-a', 'render-a', () => { saveCount += 1; return true }), true)
  assert.equal(saveCount, 1, 'a new edit explicitly releases the completed confirmation token')
})

test('draft save transaction freezes center-only origin, flow, and busy presentation until a terminal result', () => {
  const transaction = beginDraftSaveTransaction({
    origin: 'library-manual-edit',
    flow: 'update',
    busy: '正在保存中心库版本',
  })
  const polluted = resolveDraftSavePresentation({
    transaction,
    draftOrigin: 'workspace-review',
    flow: 'connect',
    busy: '正在读取工作区更新',
  })
  assert.deepEqual(polluted, {
    origin: 'library-manual-edit',
    flow: 'update',
    busy: '正在保存中心库版本',
    active: true,
  })
  const terminal = resolveDraftSavePresentation({
    transaction: null,
    draftOrigin: 'workspace-review',
    flow: 'connect',
    busy: '',
  })
  assert.equal(terminal.active, false)
  assert.equal(terminal.origin, 'workspace-review')
  assert.equal(terminal.flow, 'connect')
})

test('merged route is exact and requires an authoritative persisted receipt instead of pending comparison state', () => {
  const receipt = {
    status: 'merged',
    planId: 'plan-a',
    versionId: 'v9',
    workspacePath: 'C:\\workspace',
    fileCount: 2,
  }
  assert.deepEqual(resolveProductRoute('/workspaces/connect/merged', { mergeReceipt: receipt }), {
    screen: 'merge-success',
    receipt,
  })
  assert.deepEqual(resolveProductRoute('/workspaces/connect/merged', {
    mergeReceipt: receipt,
    pendingComparisonId: 'comparison-old',
  }), {
    screen: 'merge-success',
    receipt,
  })
  assert.deepEqual(resolveProductRoute('/workspaces/connect/merged', { mergeReceipt: null }), {
    screen: 'home',
    receipt: null,
  })
  assert.deepEqual(resolveProductRoute('/workspaces/connect/merge', { mergeReceipt: receipt }), {
    screen: 'merge-success',
    receipt,
  })
  assert.equal(resolveProductRoute('/workspaces/connect/merge', {}).screen, 'home')
  assert.equal(resolveProductRoute('/workspaces/connect/merge', { activeConnection: true }).screen, 'merge')
  assert.equal(resolveProductRoute('/workspaces/connect/merged-old', { mergeReceipt: receipt }).screen, 'connect-select')
  assert.match(app, /activeConnection: flowRef\.current === "connect"/u)
})

test('persisted receipts restore old result URLs and survive an empty in-memory overview', () => {
  const receipt = {
    status: 'merged',
    planId: 'plan-a',
    versionId: 'v9',
    workspacePath: 'C:\\workspace',
    fileCount: 1,
  }
  assert.deepEqual(resolveProductRoute('/changes/result', { mergeReceipt: receipt }), {
    screen: 'update-success',
    receipt,
  })
  assert.deepEqual(resolveProductRoute('/changes/success', { mergeReceipt: receipt }), {
    screen: 'update-success',
    receipt,
  })
  assert.deepEqual(retainAuthoritativeReceipt(receipt, null), receipt)
  assert.equal(retainAuthoritativeReceipt(null, { status: 'pending' }), null)
})

test('tombstones remain human-review only while missing deletion bodies stay fail-closed', () => {
  const files = [
    { id: 'deleted', deleted: true, editable: true, originalContentAvailable: true },
    { id: 'missing', deleted: true, editable: true, originalContentAvailable: false },
    { id: 'live', deleted: false, editable: true },
    { id: 'readonly', deleted: false, editable: false },
  ]
  assert.equal(isAiEditableFile(files[0]), false)
  assert.equal(isAiEditableFile(files[1]), false)
  assert.deepEqual(aiEditableFileIds(files), ['live'])
})

test('center-only success presentation keeps center-library semantics and receipt count', () => {
  assert.deepEqual(draftSaveSuccessPresentation({
    origin: 'library-manual-edit',
    flow: 'update',
    receipt: { status: 'merged', planId: 'plan-a', versionId: 'v9', workspacePath: 'C:\\workspace', fileCount: 1 },
    fileCount: 0,
  }), {
    centerOnly: true,
    eyebrow: '中心库已保存',
    title: '中心库已保存这次修改',
    subtitle: '已生成新的中心库版本；原版本保持可回滚。',
    fileCount: 1,
  })
  assert.equal(draftSaveSuccessPresentation({
    origin: 'workspace-review',
    receipt: { status: 'committed', planId: 'plan-a', versionId: 'v10', workspacePath: 'C:\\workspace' },
  }).centerOnly, false, 'a workspace commit receipt must retain workspace semantics')
})

test('receipt retention keeps the durable count and normalizes origin semantics', () => {
  const durable = {
    status: 'committed',
    planId: 'plan-a',
    versionId: 'v2',
    fileCount: 4,
    origin: 'library-create',
  }
  const lightweight = {
    status: 'committed',
    planId: 'plan-a',
    versionId: 'v2',
  }
  assert.deepEqual(retainAuthoritativeReceipt(durable, lightweight), durable)
  assert.equal(draftSaveSuccessPresentation({
    origin: 'library-delete',
    receipt: durable,
    fileCount: 0,
  }).fileCount, 4)
  assert.equal(draftSaveSuccessPresentation({
    origin: 'workspace-review',
    receipt: { ...durable, status: 'merged', workspacePath: 'C:\\workspace', origin: 'workspace-review' },
  }).centerOnly, false)
})

test('Round 011 flow semantics keep update progress, center context, selection labels, and takeover recovery authoritative', () => {
  assert.match(app, /type FlowVariant = "initialize" \| "update" \| "takeover" \| "center"/u)
  assert.match(app, /type TakeoverStatus = "checking" \| "active" \| "rolled-back" \| "unknown"/u)
  assert.match(app, /\["选择工作区", "只读分析", "选择连接方式", "预览并接管"\]/u)
  assert.match(app, /variant="takeover"/u)
  assert.match(app, /subtitle\.startsWith\("中心库编辑"\)/u)
  assert.match(app, /正在保存中心库版本/u)
  assert.match(app, /const \[updateReviewStep, setUpdateReviewStep\]/u)
  assert.match(app, /setUpdateReviewStep\(2\)/u)
  assert.match(app, /<FlowChrome activeStep=\{updateReviewStep\} update/u)
  assert.match(app, /!canMutateProductInputNow\(\) && !pendingSave/u)
  assert.match(app, /可选择纳入/u)
  assert.match(app, /referenceOnly[\s\S]*仅作证据/u)
  assert.match(app, /takeoverStatusChecking/u)
  assert.match(app, /pathFor\("home"\)/u)
  assert.match(app, /protectionStatus: "rolled-back"/u)
  const helperStart = app.indexOf('function authoritativeTakeoverWorkspace')
  const helperEnd = app.indexOf('\n}\n\nfunction systemSourcePaths', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'authoritative takeover helper must be present')
  const helper = app.slice(helperStart, helperEnd)
  assert.match(helper, /const candidates = array\(worktrees\)\.map\(workspaceFrom\)/u)
  assert.match(helper, /matches\.length === 1 \? matches\[0\] : null/u)
  assert.match(helper, /return candidates\.length === 1 \? candidates\[0\] : null/u)
  const statusStart = app.indexOf('if (screen !== "takeover-success")')
  const statusEnd = app.indexOf('\n  useEffect(() => {', statusStart + 1)
  assert.ok(statusStart >= 0 && statusEnd > statusStart, 'takeover status effect must be present')
  const statusEffect = app.slice(statusStart, statusEnd)
  assert.match(statusEffect, /refreshOverview\(\)\.then[\s\S]*authoritativeTakeoverWorkspace\(mapped\.worktrees, expectedPath\)/u)
  assert.match(statusEffect, /if \(!authoritative\)[\s\S]*setTakeoverStatus\("unknown"\)/u)
  assert.match(statusEffect, /catch\(\(caught: unknown\) => \{[\s\S]*setTakeoverStatus\("unknown"\)/u)
  assert.match(statusEffect, /window\.history\.replaceState\(\{\}, "", pathFor\("home"\)\)/u)
  const successStart = app.indexOf('const renderTakeoverSuccess')
  const successEnd = app.indexOf('\n  const renderWorkspaces', successStart + 1)
  assert.ok(successStart >= 0 && successEnd > successStart, 'takeover success renderer must be present')
  const success = app.slice(successStart, successEnd)
  assert.match(success, /const canRollback = takeoverStatus === "active" && !checking && Boolean\(rollbackId\)/u)
  assert.match(success, /statusUnknown/u)
  assert.doesNotMatch(success, />\$\{/u, 'takeover status copy must render JSX expressions without a literal dollar prefix')
  const rollbackStart = app.indexOf('const rollbackTakeover = useCallback')
  const rollbackEnd = app.indexOf('\n  const sendChat', rollbackStart + 1)
  assert.match(app.slice(rollbackStart, rollbackEnd), /takeoverStatus !== "active" \|\| takeoverStatusChecking/u)
})

test('manual path acceptance closes the fallback before the first analysis click', () => {
  const accepted = acceptManualWorkspacePath('  C:\\workspace  ', 7)
  assert.deepEqual(accepted, {
    accepted: true,
    path: 'C:\\workspace',
    requestId: 8,
    drawerOpen: false,
    error: '',
  })
  const empty = acceptManualWorkspacePath('   ', 7)
  assert.equal(empty.accepted, false)
  assert.equal(empty.requestId, 7)
  assert.equal(empty.drawerOpen, true)
  assert.match(empty.error, /路径/u)
})

test('create/edit library save success resets the new-file form before the next create', () => {
  const stale = { ...startNewLibraryDraft(), path: 'skills/round006-e2e/SKILL.md', content: '# stale content\n' }
  const afterCreate = completeLibraryDraft(stale, 'library-create')
  assert.deepEqual(afterCreate, { open: false, path: '', content: '# 新文件\n' })

  const nextCreate = startNewLibraryDraft()
  assert.deepEqual(nextCreate, { open: true, path: '', content: '# 新文件\n' })

  const afterEdit = completeLibraryDraft({ ...nextCreate, path: 'skills/edited/SKILL.md', content: '# edited\n' }, 'library-manual-edit')
  assert.deepEqual(afterEdit, { open: false, path: '', content: '# 新文件\n' })
  assert.equal(isLibraryDraftOrigin('workspace-review'), false)
})

test('library commit invalidates the selected detail and preserves its path for current-version readback', () => {
  const stale = {
    id: 'rule-file',
    path: 'rules/round007-disposable-rule.md',
    finalContent: '- first bullet\n',
    originalContent: '- first bullet\n',
    contentLoaded: true,
  }
  const invalidated = invalidateLibraryDetail(stale)
  assert.equal(invalidated.path, stale.path)
  assert.equal(invalidated.contentLoaded, false)
  assert.equal(invalidated.finalContent, '')
  assert.equal(invalidated.originalContent, '')

  const candidate = preferredLibraryFile(invalidated, [
    { path: 'skills/first/SKILL.md' },
    { path: stale.path },
  ])
  assert.equal(candidate.path, stale.path, 'the same file should be reloaded after the version changes')
  assert.match(app, /const refreshLibrary = useCallback/u)
  assert.match(app, /await refreshLibrary()/u)
  assert.ok(app.includes('setActiveFile((current) => invalidateLibraryDetail(current))'))
  assert.ok(app.includes('preferredLibraryFile(activeFile, filteredLibraryFiles)'))
})

test('home recheck presents an immediate busy state and restores controls for every terminal result', () => {
  const pending = workspaceRecheckPresentation({ phase: 'pending', hasChanges: 0 })
  assert.equal(pending.pending, true)
  assert.equal(pending.ariaBusy, true)
  assert.equal(pending.disabled, true)
  assert.match(pending.heading, /重新检查|正在/u)
  assert.doesNotMatch(pending.heading, /没有待处理修改/u)

  for (const phase of ['success', 'failure', 'cancelled']) {
    const recovered = workspaceRecheckPresentation({ phase, hasChanges: 0 })
    assert.equal(recovered.pending, false, `${phase} should clear pending state`)
    assert.equal(recovered.ariaBusy, false, `${phase} should clear aria-busy`)
    assert.equal(recovered.disabled, false, `${phase} should re-enable recheck`)
    assert.equal(recovered.actionLabel, '重新检查')
  }
  assert.equal(workspaceRecheckPresentation({ phase: 'success', hasChanges: 2 }).heading, '有 2 项新修改待处理')
})

test('AI instructions reset when flow, draft, or selected file scope changes', () => {
  const first = {
    ...createAiInstructionState({ flowId: 'update-1', draftId: 'draft-a', fileIds: ['file-a'] }),
    prompt: '只改旧文件说明',
    resultPrompt: '保留旧草稿命令',
  }
  const newDraft = transitionAiInstructionScope(first, { flowId: 'update-1', draftId: 'draft-b', fileIds: ['file-a'] })
  assert.equal(newDraft.prompt, '')
  assert.equal(newDraft.resultPrompt, '')
  const newFlow = transitionAiInstructionScope(newDraft, { flowId: 'delete-1', draftId: 'draft-c', fileIds: ['file-b'] })
  assert.deepEqual(newFlow.fileIds, ['file-b'])
  assert.equal(newFlow.prompt, '')
  const newFileSelection = resetAiFileSelection({ ...newFlow, prompt: '不能带到另一个文件集' }, ['file-c'])
  assert.deepEqual(newFileSelection.fileIds, ['file-c'])
  assert.equal(newFileSelection.prompt, '')
  assert.equal(shouldShowAiCancel({ aiProcessing: false, aiCancellable: true }), false, 'save/commit busy state cannot show AI cancel')
  assert.equal(shouldShowAiCancel({ aiProcessing: true, aiCancellable: false }), false, 'a non-cancellable AI phase cannot show cancel')
  assert.equal(shouldShowAiCancel({ aiProcessing: true, aiCancellable: true }), true)
})

test('AI cancellation tombstones late chunks and completion callbacks across a new flow', async () => {
  const gate = createAiRequestGate({ flowId: 'update:workspace', draftId: 'draft-a', fileIds: ['cache-control'] })
  const state = {
    prompt: 'SG-R009-CANCEL-ONLY-20260827：只为选中的 cache-control 生成简短草稿。',
    resultPrompt: '保留用户成果页指令',
    assistantText: '',
    screen: 'update-compare',
    savedVersion: false,
  }
  const publish = (request, callback) => {
    if (!gate.isCurrent(request)) return false
    callback()
    return true
  }
  const first = gate.begin({ prompt: state.prompt, promptKind: 'draft', operationId: 'request-a' }).request
  const lateChunk = Promise.resolve().then(() => publish(first, () => {
    state.prompt += ' 模型晚到的 chunk'
    state.assistantText += '模型晚到的 assistant text'
  }))
  const lateCompletion = Promise.resolve().then(() => publish(first, () => {
    state.resultPrompt += ' 模型晚到的 completion'
    state.screen = 'update-result'
    state.savedVersion = true
  }))

  assert.equal(gate.cancel(), first)
  assert.equal(first.controller.signal.aborted, true)
  await Promise.all([lateChunk, lateCompletion])

  assert.equal(state.prompt, 'SG-R009-CANCEL-ONLY-20260827：只为选中的 cache-control 生成简短草稿。')
  assert.equal(state.resultPrompt, '保留用户成果页指令')
  assert.equal(state.assistantText, '')
  assert.equal(state.screen, 'update-compare')
  assert.equal(state.savedVersion, false)

  gate.setScope({ flowId: 'update:workspace', draftId: 'draft-b', fileIds: ['backup-plans'] })
  const second = gate.begin({ prompt: '新草稿流程指令', promptKind: 'draft', operationId: 'request-b' }).request
  assert.notEqual(second.scopeKey, first.scopeKey)
  assert.deepEqual(second.fileIds, ['backup-plans'])
  assert.equal(publish(first, () => { state.prompt += ' 旧请求再次晚到' }), false)

  assert.equal(publish(second, () => {
    state.assistantText = '正常未取消回答'
    state.screen = 'update-result'
    state.savedVersion = true
  }), true)
  assert.equal(state.assistantText, '正常未取消回答')
  assert.equal(state.screen, 'update-result')
  assert.equal(state.savedVersion, true)
  assert.equal(gate.finish(second), true)
})

test('AI cancellation uses a synchronous input lock until settlement completes', () => {
  const canMutateStart = app.indexOf('const canMutateProductInputNow')
  const canMutateEnd = app.indexOf('\n  useEffect(() => {', canMutateStart)
  const canMutateSource = app.slice(canMutateStart, canMutateEnd)
  assert.match(canMutateSource, /aiComposerLockRef\.current\s*\|\|\s*aiInputLockRef\.current/u)
  assert.match(app, /const aiComposerLocked = aiInputLockRef\.current \|\| aiCancelSettling/u)
  const processStart = app.indexOf('const processAi = useCallback')
  const processEnd = app.indexOf('\n  const cancelAi = useCallback', processStart)
  const processSource = app.slice(processStart, processEnd)
  assert.match(processSource, /aiInputLockRef\.current = true/u)
  assert.match(processSource, /aiInputLockRef\.current = false/u)
  const cancelStart = app.indexOf('const cancelAi = useCallback')
  const cancelEnd = app.indexOf('\n  const saveFile', cancelStart)
  const cancelSource = app.slice(cancelStart, cancelEnd)
  assert.match(cancelSource, /aiInputLockRef\.current = true/u)
  assert.match(app, /aiComposerLockRef\.current = false;\n      aiInputLockRef\.current = false;/u)
  assert.equal(canMutateProductInput({ aiActive: true, busy: '', requestLocked: false }), false)
})

test('AI composer contract freezes the submitted snapshot, locks all fields, restores cancel symmetrically, and allows the next scope', () => {
  const initialFileIds = ['file-a', 'file-b']
  const machine = createAiComposerStateMachine({ flowId: 'update-flow', draftId: 'draft-a', fileIds: initialFileIds })
  const draftPrompt = '  SG-R010-001：只整理选中的两个文件。  '
  const resultPrompt = '成果页保留命令和路径。'
  assert.equal(machine.setPrompt('draft', draftPrompt), true)
  assert.equal(machine.setPrompt('result', resultPrompt), true)
  initialFileIds.push('file-outside-snapshot')

  const filePaths = ['skills/cache-control/SKILL.md', 'skills/backup-plans/SKILL.md']
  const first = machine.begin({
    prompt: draftPrompt,
    promptKind: 'draft',
    operationId: 'operation-before-session',
    filePaths,
    comparisonId: 'comparison-a',
    planId: 'plan-a',
    workspacePath: 'C:\\workspace-a',
  }).request
  filePaths.push('skills/late-file/SKILL.md')

  assert.equal(first.prompt, draftPrompt)
  assert.equal(first.submittedPrompt, draftPrompt)
  assert.equal(first.promptKind, 'draft')
  assert.equal(first.promptField, 'aiPrompt')
  assert.equal(first.snapshot.prompt, draftPrompt)
  assert.equal(first.snapshot.promptKind, 'draft')
  assert.equal(first.snapshot.promptField, 'aiPrompt')
  assert.equal(first.snapshot.flowId, 'update-flow')
  assert.equal(first.snapshot.draftId, 'draft-a')
  assert.deepEqual(first.snapshot.fileIds, ['file-a', 'file-b'])
  assert.deepEqual(first.snapshot.filePaths, ['skills/cache-control/SKILL.md', 'skills/backup-plans/SKILL.md'])
  assert.equal(first.snapshot.comparisonId, 'comparison-a')
  assert.equal(first.snapshot.planId, 'plan-a')
  assert.equal(first.snapshot.workspacePath, 'C:\\workspace-a')
  assert.equal(first.snapshot.operationId, 'operation-before-session')
  assert.equal(first.snapshot.scopeToken, first.scopeToken)
  assert.equal(first.snapshot.promptState.aiPrompt, draftPrompt)
  assert.equal(first.snapshot.promptState.resultPrompt, resultPrompt)
  assert.equal(Object.isFrozen(first.snapshot), true)
  assert.equal(Object.isFrozen(first.snapshot.fileIds), true)
  assert.equal(Object.isFrozen(first.snapshot.filePaths), true)
  assert.equal(Object.isFrozen(first.snapshot.promptState), true)

  const runningTextareas = ['merge-ai-composer', 'update-ai-composer', 'result-ai-composer'].map((testId) => ({
    testId,
    disabled: false,
    readOnly: isAiComposerLocked({ aiProcessing: true, busy: '正在生成 AI 草稿' }),
  }))
  assert.ok(runningTextareas.every((textarea) => textarea.disabled || textarea.readOnly), 'every AI textarea must be readOnly or disabled while running')
  assert.equal(isAiComposerLocked({ aiProcessing: false, busy: '' }), false)
  assert.equal(machine.state().locked, true)
  assert.equal(machine.setPrompt('draft', 'same-tick synthetic mutation'), false)
  assert.equal(machine.setPrompt('result', 'same-tick result mutation'), false)
  assert.equal(machine.state().aiPrompt, draftPrompt)
  assert.equal(machine.state().resultPrompt, resultPrompt)
  const secondBegin = machine.begin({ prompt: 'same-tick second submit', promptKind: 'draft', operationId: 'operation-second' })
  assert.equal(secondBegin.request, null)
  assert.equal(secondBegin.rejected, true)
  assert.equal(secondBegin.superseded, first)

  const restoreCheck = createAiComposerStateMachine({ flowId: 'restore-check', draftId: 'draft-a', fileIds: ['file-a'] })
  assert.equal(restoreCheck.setPrompt('draft', 'restore before unlock'), true)
  const restoreRequest = restoreCheck.begin({ prompt: 'restore before unlock', operationId: 'restore-check-operation' }).request
  const restoreSettlement = restoreCheck.beginCancelSettlement()
  const settlementRenderToken = restoreCheck.inputToken()
  assert.equal(restoreCheck.markCancelRestoreCommitted(restoreSettlement.settlement), false)
  assert.equal(restoreCheck.settleCancel(restoreSettlement.settlement, { uiSettled: true, cancelRequestSettled: true }), false)
  assert.equal(restoreCheck.state().locked, true)
  assert.ok(restoreCheck.restoreCancelledPrompt(restoreRequest))
  assert.equal(restoreCheck.markCancelRestoreCommitted(restoreSettlement.settlement), true)
  assert.equal(restoreCheck.settleCancel(restoreSettlement.settlement, { uiSettled: true, cancelRequestSettled: true }), true)
  assert.notEqual(restoreCheck.inputToken(), settlementRenderToken, 'ordinary composer settlement must advance the input epoch')
  assert.equal(restoreCheck.setPrompt('draft', 'old settlement render input', settlementRenderToken), false, 'the settlement render token must be stale after unlock')
  assert.equal(restoreCheck.setPrompt('draft', 'new render input after settlement'), true)

  const cancellation = machine.beginCancelSettlement()
  const cancelled = cancellation.request
  const cancellationToken = cancellation.settlement
  assert.equal(cancelled, first)
  assert.ok(cancellationToken)
  assert.equal(cancelled.sessionId, '', 'the cancel path must work before a provider session id exists')
  assert.equal(cancelled.controller.signal.aborted, true)
  const restoredDraft = machine.restoreCancelledPrompt(cancelled)
  assert.deepEqual(restoredDraft, { aiPrompt: draftPrompt, resultPrompt })
  assert.equal(machine.markCancelRestoreCommitted(cancellationToken), true)
  assert.equal(machine.state().cancelling, true)
  assert.equal(machine.state().locked, true, 'restore must stay locked until the UI and cancel request settle')
  assert.equal(machine.setPrompt('draft', 'queued late onChange after cancel restore'), false, 'queued old onChange must be rejected during settlement')
  assert.equal(machine.state().aiPrompt, draftPrompt)
  assert.equal(machine.settleCancel(cancellationToken, { uiSettled: true }), false)
  assert.equal(machine.state().locked, true)
  assert.equal(machine.settleCancel(cancellationToken, { cancelRequestSettled: true }), true)
  assert.equal(machine.state().locked, false)
  assert.equal(machine.state().cancelling, false)
  assert.equal(canMutateProductInput({ aiActive: machine.state().locked, busy: '', requestLocked: false }), true, 'the editor boundary is open again after cancellation settlement')
  assert.equal(machine.setPrompt('draft', 'user edits after cancel'), true, 'a real edit is accepted after settlement unlocks')
  assert.equal(machine.restoreCancelledPrompt(first), null, 'a late restore callback must not overwrite a post-cancel user edit')
  assert.equal(machine.state().aiPrompt, 'user edits after cancel')
  assert.equal(first.snapshot.prompt, draftPrompt, 'late state changes must not mutate the immutable request snapshot')

  const effects = { navigated: false, files: ['file-a'], version: 'v1' }
  const publish = (request, callback) => {
    if (!machine.isCurrent(request)) return false
    callback()
    return true
  }
  assert.equal(publish(first, () => {
    effects.navigated = true
    effects.files = ['late-file']
    effects.version = 'v2'
  }), false)
  assert.deepEqual(effects, { navigated: false, files: ['file-a'], version: 'v1' }, 'late completion must not navigate or update files/version')

  const resultSubmitted = '  成果页只改说明，不动命令。  '
  assert.equal(machine.setPrompt('result', resultSubmitted), true)
  const resultRequest = machine.begin({
    prompt: resultSubmitted,
    promptKind: 'result',
    operationId: 'operation-result-before-session',
    filePaths: ['skills/cache-control/SKILL.md'],
    comparisonId: 'comparison-result',
    planId: 'plan-a',
    workspacePath: 'C:\\workspace-a',
  }).request
  assert.equal(resultRequest.promptField, 'resultPrompt')
  assert.equal(machine.setPrompt('result', 'late result mutation'), false)
  const resultCancellation = machine.beginCancelSettlement()
  assert.equal(resultCancellation.request, resultRequest)
  const restoredResult = machine.restoreCancelledPrompt(resultRequest)
  assert.equal(restoredResult.resultPrompt, resultSubmitted)
  assert.equal(restoredResult.aiPrompt, 'user edits after cancel', 'result cancel must not contaminate the draft field')
  assert.equal(machine.markCancelRestoreCommitted(resultCancellation.settlement), true)
  assert.equal(machine.settleCancel(resultCancellation.settlement, { uiSettled: true, cancelRequestSettled: true }), true)
  assert.deepEqual({ requestId: resultRequest.operationId }, { requestId: 'operation-result-before-session' })

  machine.setScope({ flowId: 'new-flow', draftId: 'draft-b', fileIds: ['file-new'] })
  assert.deepEqual(machine.currentPromptState(), { aiPrompt: '', resultPrompt: '' }, 'a new flow/file scope must start with empty composers')
  assert.equal(machine.setPrompt('draft', 'normal request completes'), true)
  const normal = machine.begin({
    prompt: 'normal request completes',
    promptKind: 'draft',
    operationId: 'operation-normal',
    filePaths: ['skills/new/SKILL.md'],
    comparisonId: 'comparison-new',
    planId: 'plan-a',
    workspacePath: 'C:\\workspace-a',
  }).request
  assert.equal(machine.isCurrent(normal), true)
  assert.equal(publish(normal, () => {
    effects.navigated = true
    effects.files = ['skills/new/SKILL.md']
    effects.version = 'draft-result'
  }), true)
  assert.deepEqual(effects, { navigated: true, files: ['skills/new/SKILL.md'], version: 'draft-result' })
  assert.equal(machine.finish(normal), true)
  assert.equal(machine.state().locked, false)
  assert.equal(machine.setPrompt('draft', 'editable after normal completion'), true)
})

test('product AI API keeps AbortSignal out of the JSON body and forwards it to fetch', async () => {
  const calls = []
  const controller = new AbortController()
  const client = createPanelApi({
    fetch: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200, text: async () => JSON.stringify({ cancelled: true }) }
    },
  })

  await client.productApi.draftAi({ requestId: 'request-a', message: '只处理选中文件' }, { signal: controller.signal })
  await client.productApi.chatCancel({ requestId: 'request-a' }, { signal: controller.signal })

  assert.equal(calls[0].init.signal, controller.signal)
  assert.deepEqual(JSON.parse(calls[0].init.body), { requestId: 'request-a', message: '只处理选中文件' })
  assert.equal(calls[1].url, '/api/product/chat/cancel')
  assert.equal(calls[1].init.signal, controller.signal)
  assert.deepEqual(JSON.parse(calls[1].init.body), { requestId: 'request-a' })
})

test('interaction gates fail closed for same-tick scope edits, navigation, result writes, and chat replacement', () => {
  const machine = createAiComposerStateMachine({ flowId: 'update-flow', draftId: 'draft-a', fileIds: ['file-a'] })
  assert.equal(machine.setPrompt('draft', 'keep this prompt'), true)
  const running = machine.begin({ prompt: 'keep this prompt', operationId: 'ai-running' }).request
  const beforeScope = machine.currentScope()
  const beforePrompt = machine.currentPromptState()

  const sameTickSelection = (fileIds) => {
    if (!canMutateProductInput({ aiActive: machine.isLocked(), busy: '', requestLocked: false })) return false
    return machine.setScope({ ...beforeScope, fileIds }) !== false
  }
  assert.equal(sameTickSelection(['file-b']), false, 'active AI must reject selection in the handler itself')
  assert.deepEqual(machine.currentScope(), beforeScope)
  assert.deepEqual(machine.currentPromptState(), beforePrompt)
  assert.equal(machine.state().locked, true)

  assert.equal(canMutateProductInput({ aiActive: true, busy: '', requestLocked: false }), false)
  assert.equal(canMutateProductInput({ aiActive: false, busy: '正在保存文件草稿', requestLocked: false }), false)
  assert.equal(canMutateProductInput({ aiActive: false, busy: '', requestLocked: true }), false)
  assert.equal(canNavigateProduct({ aiActive: true, busy: '正在生成 AI 草稿', requestLocked: false }), false)
  assert.equal(canNavigateProduct({ aiActive: false, busy: '正在保存文件草稿', requestLocked: false }), false)
  assert.equal(canNavigateProduct({ aiActive: false, busy: '', requestLocked: false, writeLocked: true }), false)
  assert.equal(canNavigateProduct({ aiActive: false, busy: '', requestLocked: true }), false)
  assert.equal(canNavigateProduct({ aiActive: true, busy: '正在生成 AI 草稿', requestLocked: false, authorization: 'ai-success' }), true)
  assert.equal(canNavigateProduct({ aiActive: true, busy: '正在生成 AI 草稿', requestLocked: false, authorization: 'cancel' }), false)
  assert.equal(canNavigateProduct({ aiActive: false, busy: '', requestLocked: false, authorization: 'cancel' }), true)
  assert.equal(canNavigateProduct({ aiActive: true, busy: '正在生成 AI 草稿', requestLocked: false, writeLocked: true, authorization: 'ai-success' }), false)
  assert.equal(canNavigateProduct({ aiActive: true, busy: '正在生成 AI 草稿', requestLocked: false, writeLocked: true, authorization: 'cancel' }), false)

  const cancellation = machine.beginCancelSettlement()
  assert.equal(cancellation.request, running)
  assert.equal(machine.isCurrent(running), false)
  machine.restoreCancelledPrompt(running)
  machine.markCancelRestoreCommitted(cancellation.settlement)
  assert.equal(machine.settleCancel(cancellation.settlement, { uiSettled: true, cancelRequestSettled: true }), true)

  const chatGate = createAiRequestGate({ flowId: 'assistant' })
  let busy = '正在发送消息'
  let error = '旧错误'
  const oldChat = chatGate.begin({ prompt: '旧消息', promptKind: 'assistant', operationId: 'chat-old' }).request
  assert.equal(chatGate.isCurrent(oldChat), true)
  chatGate.cancel()
  busy = ''
  error = ''
  assert.equal(chatGate.isCurrent(oldChat), false, 'old chat callback must be tombstoned by new chat')
  const oldFinally = () => {
    if (chatGate.isCurrent(oldChat)) busy = ''
  }
  const nextChat = chatGate.begin({ prompt: '新消息', promptKind: 'assistant', operationId: 'chat-new' }).request
  assert.ok(nextChat, 'next message is accepted after startNewChat clears the old gate')
  busy = '正在发送消息'
  oldFinally()
  assert.equal(busy, '正在发送消息', 'old finally must not clear the new chat busy state')
  assert.equal(error, '')
  assert.equal(chatGate.isCurrent(nextChat), true)
  assert.equal(chatGate.finish(nextChat), true)
  busy = ''
  assert.equal(canMutateProductInput({ busy, requestLocked: chatGate.isLocked() }), true)
})

test('write lock is part of the executable product mutation gate and recovers after release', () => {
  const machine = createAiComposerStateMachine({ flowId: 'write-gate', draftId: 'draft-a', fileIds: ['file-a'] })
  let writeBusy = true
  let selected = new Set(['file-a'])
  let editor = 'before'
  let saves = 0
  let confirms = 0
  let commits = 0
  let aiRuns = 0
  const canMutate = () => canMutateProductInput({
    aiActive: machine.isLocked(),
    busy: '',
    requestLocked: false,
    writeLocked: writeBusy,
  })
  const guarded = (action) => {
    if (!canMutate()) return false
    action()
    return true
  }

  assert.equal(guarded(() => machine.setPrompt('draft', 'must stay unchanged')), false)
  assert.equal(guarded(() => { selected = new Set(['file-b']) }), false)
  assert.equal(guarded(() => { editor = 'blocked' }), false)
  assert.equal(guarded(() => { saves += 1 }), false)
  assert.equal(guarded(() => { confirms += 1 }), false)
  assert.equal(guarded(() => { commits += 1 }), false)
  assert.equal(guarded(() => { aiRuns += 1 }), false)
  assert.equal(canNavigateProduct({ busy: '', writeLocked: writeBusy, authorization: 'user' }), false)
  assert.deepEqual([...selected], ['file-a'])
  assert.equal(editor, 'before')
  assert.deepEqual({ saves, confirms, commits, aiRuns }, { saves: 0, confirms: 0, commits: 0, aiRuns: 0 })

  writeBusy = false
  assert.equal(guarded(() => machine.setPrompt('draft', 'accepted after write')), true)
  assert.equal(guarded(() => { selected = new Set(['file-b']) }), true)
  assert.equal(guarded(() => { editor = 'accepted' }), true)
  assert.equal(guarded(() => { saves += 1 }), true)
  assert.equal(guarded(() => { confirms += 1 }), true)
  assert.equal(guarded(() => { commits += 1 }), true)
  assert.equal(guarded(() => { aiRuns += 1 }), true)
  assert.equal(canNavigateProduct({ busy: '', writeLocked: writeBusy, authorization: 'user' }), true)
  assert.deepEqual([...selected], ['file-b'])
  assert.equal(editor, 'accepted')
  assert.deepEqual({ saves, confirms, commits, aiRuns }, { saves: 1, confirms: 1, commits: 1, aiRuns: 1 })
})

test('merge selection uses the same gate and cannot clear an active AI prompt', () => {
  const machine = createAiComposerStateMachine({ flowId: 'merge-flow', draftId: 'draft-a', fileIds: ['file-a', 'file-b'] })
  assert.equal(machine.setPrompt('draft', 'keep this merge instruction'), true)
  const selected = new Set(['path-a'])
  const oldSelectionToken = machine.inputToken()
  const running = machine.begin({ prompt: 'keep this merge instruction', promptKind: 'draft', operationId: 'merge-ai' }).request
  const guardedMergeSelection = (next, selectionToken = oldSelectionToken) => {
    if (selectionToken !== machine.inputToken()) return false
    if (!canMutateProductInput({ aiActive: machine.isLocked(), busy: '', requestLocked: false, writeLocked: false })) return false
    if (!machine.clearPromptState()) return false
    selected.clear()
    for (const pathValue of next) selected.add(pathValue)
    return true
  }

  assert.equal(guardedMergeSelection(['path-b']), false)
  assert.deepEqual([...selected], ['path-a'])
  assert.equal(machine.state().aiPrompt, 'keep this merge instruction')

  const cancellation = machine.beginCancelSettlement()
  assert.equal(cancellation.request, running)
  assert.ok(machine.restoreCancelledPrompt(running))
  assert.equal(machine.markCancelRestoreCommitted(cancellation.settlement), true)
  assert.equal(machine.settleCancel(cancellation.settlement, { uiSettled: true, cancelRequestSettled: true }), true)
  assert.equal(guardedMergeSelection(['late-path']), false, 'an old merge selection callback must remain rejected after unlock')
  assert.equal(guardedMergeSelection(['path-b'], machine.inputToken()), true, 'a new render selection token is accepted after unlock')
  assert.deepEqual([...selected], ['path-b'])
  assert.deepEqual(machine.currentPromptState(), { aiPrompt: '', resultPrompt: '' })

  let mergeNote = ''
  let editor = 'before'
  let saves = 0
  const guardedMergeNote = (value, noteToken = oldSelectionToken) => {
    if (noteToken !== machine.inputToken()) return false
    if (!canMutateProductInput({ aiActive: machine.isLocked(), busy: '', requestLocked: false, writeLocked: false })) return false
    mergeNote = value
    return true
  }
  const guardedEditorChange = (value, editorToken = oldSelectionToken) => {
    if (editorToken !== machine.inputToken()) return false
    if (!canMutateProductInput({ aiActive: machine.isLocked(), busy: '', requestLocked: false, writeLocked: false })) return false
    editor = value
    return true
  }
  const guardedEditorBlur = (value, editorToken = oldSelectionToken) => {
    if (editorToken !== machine.inputToken()) return false
    if (!canMutateProductInput({ aiActive: machine.isLocked(), busy: '', requestLocked: false, writeLocked: false })) return false
    saves += 1
    editor = value
    return true
  }
  assert.equal(guardedMergeNote('late old merge note'), false, 'an old merge-note callback must remain rejected after unlock')
  assert.equal(guardedEditorChange('late old editor body'), false, 'an old editor change callback must remain rejected after unlock')
  assert.equal(guardedEditorBlur('late old editor body'), false, 'an old editor blur callback must not save after unlock')
  assert.equal(mergeNote, '')
  assert.equal(editor, 'before')
  assert.equal(saves, 0)
  const currentInputToken = machine.inputToken()
  assert.equal(guardedMergeNote('new render merge note', currentInputToken), true)
  assert.equal(guardedEditorChange('new render editor body', currentInputToken), true)
  assert.equal(guardedEditorBlur('new render editor body', currentInputToken), true)
  assert.equal(mergeNote, 'new render merge note')
  assert.equal(editor, 'new render editor body')
  assert.equal(saves, 1)
})

test('library draft entry closes the write gate before its first await', async () => {
  let writeBusy = false
  let executions = 0
  const beginLibraryDraft = async () => {
    if (!canMutateProductInput({ aiActive: false, busy: '', requestLocked: false, writeLocked: writeBusy })) return false
    writeBusy = true
    try {
      await Promise.resolve()
      executions += 1
      return true
    } finally {
      writeBusy = false
    }
  }

  const first = beginLibraryDraft()
  const second = beginLibraryDraft()
  assert.equal(await second, false, 'a same-tick second library draft must fail before its first await')
  assert.equal(await first, true)
  assert.equal(executions, 1)
  assert.equal(await beginLibraryDraft(), true, 'the library entry recovers after the write gate releases')
})

test('pending AI reset stays locked, rejects a second reset and applies the next scope atomically', () => {
  const machine = createAiComposerStateMachine({ flowId: 'old-flow', draftId: 'old-draft', fileIds: ['old-file'] })
  const oldPrompt = 'old request prompt'
  assert.equal(machine.setPrompt('draft', oldPrompt), true)
  const oldInputToken = machine.inputToken()
  const oldRequest = machine.begin({ prompt: oldPrompt, operationId: 'old-operation' }).request
  const pending = machine.resetScope({ flowId: 'new-flow', draftId: 'new-draft', fileIds: ['new-file'] })

  assert.equal(pending.accepted, true)
  assert.equal(pending.pending, true)
  assert.equal(machine.state().locked, true)
  assert.equal(machine.currentScope().flowId, 'old-flow')
  assert.equal(machine.setPrompt('draft', 'queued old input', oldInputToken), false)
  assert.equal(machine.resetScope({ flowId: 'other-flow', draftId: 'other-draft', fileIds: ['other-file'] }).accepted, false)

  assert.ok(machine.restoreCancelledPrompt(oldRequest))
  assert.equal(machine.markCancelRestoreCommitted(pending.settlement), true)
  assert.equal(machine.settleCancel(pending.settlement, { uiSettled: true }), false)
  assert.equal(machine.state().locked, true)
  assert.equal(machine.settleCancel(pending.settlement, { cancelRequestSettled: true }), true)
  assert.equal(machine.state().locked, false)
  assert.equal(machine.currentScope().flowId, 'new-flow')
  assert.equal(machine.currentScope().draftId, 'new-draft')
  assert.deepEqual(machine.currentScope().fileIds, ['new-file'])
  assert.deepEqual(machine.currentPromptState(), { aiPrompt: '', resultPrompt: '' })
  assert.equal(machine.setPrompt('draft', 'old closure after unlock', oldInputToken), false)
  const newInputToken = machine.inputToken()
  assert.notEqual(newInputToken, oldInputToken)
  assert.equal(machine.setPrompt('draft', 'new render input', newInputToken), true)
  assert.equal(machine.state().aiPrompt, 'new render input')
})

test('cancel rejection keeps the affected AI scope locked until an isolated scope is selected', () => {
  const machine = createAiComposerStateMachine({ flowId: 'cancel-failure', draftId: 'draft-a', fileIds: ['file-a'] })
  assert.equal(machine.setPrompt('draft', 'unsafe to unlock'), true)
  const request = machine.begin({ prompt: 'unsafe to unlock', operationId: 'cancel-failure-operation' }).request
  const cancellation = machine.beginCancelSettlement()
  assert.equal(cancellation.request, request)
  assert.ok(machine.restoreCancelledPrompt(request))
  assert.equal(machine.markCancelRestoreCommitted(cancellation.settlement), true)
  assert.equal(machine.failCancelSettlement(cancellation.settlement, 'network failure'), true)
  assert.equal(machine.state().cancelFailed, true)
  assert.equal(machine.state().locked, true)
  assert.equal(machine.restoreCancelledPrompt(request), null, 'a late restore cannot mutate a failed cancellation settlement')
  assert.equal(machine.settleCancel(cancellation.settlement, { uiSettled: true, cancelRequestSettled: true }), false)
  assert.equal(machine.setPrompt('draft', 'same draft must remain locked'), false)
  assert.equal(machine.resetScope({ flowId: 'cancel-failure', draftId: 'draft-a', fileIds: ['file-a'] }).accepted, false)

  const failedBeforeRestore = createAiComposerStateMachine({ flowId: 'restore-failure', draftId: 'draft-a', fileIds: ['file-a'] })
  assert.equal(failedBeforeRestore.setPrompt('draft', 'restore failure must isolate'), true)
  const failedRequest = failedBeforeRestore.begin({ prompt: 'restore failure must isolate', operationId: 'restore-failure-operation' }).request
  const failedSettlement = failedBeforeRestore.beginCancelSettlement().settlement
  assert.equal(failedBeforeRestore.restoreCancelledPrompt({ operationId: 'wrong-request' }), null)
  assert.equal(failedBeforeRestore.markCancelRestoreCommitted(failedSettlement), false)
  assert.equal(failedBeforeRestore.failCancelSettlement(failedSettlement, 'restore acknowledgement missing'), true)
  assert.equal(failedBeforeRestore.state().locked, true, 'restore/mark failure must remain fail-closed, not unlock the old draft')
  assert.equal(failedBeforeRestore.setPrompt('draft', 'must stay unavailable'), false)
  assert.equal(failedBeforeRestore.resetScope({ flowId: 'restore-failure', draftId: 'draft-a', fileIds: ['file-a'] }).accepted, false)
  const recoveredAfterRestoreFailure = failedBeforeRestore.resetScope({ flowId: 'isolated-restore-recovery', draftId: 'draft-b', fileIds: ['file-b'] })
  assert.equal(recoveredAfterRestoreFailure.accepted, true)
  assert.equal(failedBeforeRestore.state().locked, false, 'explicit isolated recovery must release the fail-closed lock')
  assert.equal(failedBeforeRestore.setPrompt('draft', 'isolated recovery is editable'), true)
  assert.equal(failedBeforeRestore.isCurrent(failedRequest), false, 'the failed old request remains tombstoned after recovery')

  const isolated = machine.resetScope({ flowId: 'isolated-after-cancel-failure', draftId: 'draft-b', fileIds: ['file-b'] })
  assert.equal(isolated.accepted, true)
  assert.equal(isolated.isolated, true)
  assert.equal(machine.state().locked, false)
  assert.deepEqual(machine.currentPromptState(), { aiPrompt: '', resultPrompt: '' })
  assert.equal(machine.setPrompt('draft', 'new isolated request'), true)
  assert.equal(machine.begin({ prompt: 'new isolated request', operationId: 'new-isolated-operation' }).request !== null, true)
})

test('chat cancellation settlement blocks the next submit and isolates after cancellation failure', () => {
  const chat = createAiRequestGate({ flowId: 'assistant' })
  const old = chat.begin({ prompt: 'old message', promptKind: 'assistant', operationId: 'chat-old' }).request
  const pending = chat.beginCancelSettlement()
  assert.equal(pending.request, old)
  assert.equal(chat.isLocked(), true)
  assert.equal(chat.begin({ prompt: 'new message', promptKind: 'assistant', operationId: 'chat-new' }).request, null)
  assert.equal(chat.isCurrent(old), false)
  const settlementRenderToken = chat.inputToken()
  assert.equal(chat.settleCancellation(pending.settlement), true)
  assert.equal(chat.isLocked(), false)
  assert.notEqual(chat.inputToken(), settlementRenderToken, 'chat settlement must advance the input epoch')
  const next = chat.begin({ prompt: 'new message', promptKind: 'assistant', operationId: 'chat-new' }).request
  assert.ok(next)
  assert.equal(chat.finish(next), true)

  const failedChat = createAiRequestGate({ flowId: 'assistant' })
  const failedOld = failedChat.begin({ prompt: 'old remote message', promptKind: 'assistant', operationId: 'chat-failed-old' }).request
  const failed = failedChat.beginCancelSettlement()
  assert.equal(failedChat.settleCancellation(failed.settlement, { success: false, failure: 'cancel unavailable' }), false)
  assert.equal(failedChat.isLocked(), true)
  assert.equal(failedChat.begin({ prompt: 'must wait', promptKind: 'assistant', operationId: 'chat-blocked' }).request, null)
  assert.equal(failedChat.isCurrent(failedOld), false)
  assert.ok(failedChat.recoverFailedCancellation({ flowId: 'assistant:new-isolated', draftId: '', fileIds: [] }))
  assert.equal(failedChat.isLocked(), false)
  assert.ok(failedChat.begin({ prompt: 'isolated new message', promptKind: 'assistant', operationId: 'chat-isolated' }).request)
})

test('chat input uses a render token and rejects old settlement callbacks', () => {
  const chat = createAiRequestGate({ flowId: 'assistant' })
  const old = chat.begin({ prompt: 'old message', promptKind: 'assistant', operationId: 'chat-input-old' }).request
  const oldActiveToken = chat.inputToken()
  let draft = ''
  const guardedChatInput = (value, inputToken = oldActiveToken, { busy = '', writeLocked = false } = {}) => {
    if (inputToken !== chat.inputToken()) return false
    if (!canMutateProductInput({ aiActive: false, busy, requestLocked: chat.isLocked(), writeLocked })) return false
    draft = value
    return true
  }

  assert.equal(guardedChatInput('active callback'), false)
  assert.equal(draft, '')
  const cancellation = chat.beginCancelSettlement()
  const settlementRenderToken = chat.inputToken()
  assert.equal(chat.isLocked(), true)
  assert.equal(guardedChatInput('queued cancellation callback', settlementRenderToken), false)
  assert.equal(chat.isCurrent(old), false)
  assert.equal(chat.settleCancellation(cancellation.settlement), true)
  assert.notEqual(chat.inputToken(), settlementRenderToken, 'successful chat settlement must advance the input epoch')
  assert.equal(guardedChatInput('old callback after unlock', settlementRenderToken), false)
  assert.equal(guardedChatInput('busy callback', chat.inputToken(), { busy: '正在保存文件草稿' }), false)
  assert.equal(guardedChatInput('write callback', chat.inputToken(), { writeLocked: true }), false)
  const newRenderToken = chat.inputToken()
  assert.equal(guardedChatInput('new render chat input', newRenderToken), true)
  assert.equal(draft, 'new render chat input')
})

test('render tokens and write reservations protect every explicit write entry', () => {
  const machine = createAiComposerStateMachine({ flowId: 'write-entry-flow', draftId: 'draft-a', fileIds: ['file-a'] })
  assert.equal(machine.setPrompt('draft', 'write entry snapshot'), true)
  const request = machine.begin({ prompt: 'write entry snapshot', operationId: 'write-entry-old' }).request
  const cancellation = machine.beginCancelSettlement()
  const oldRenderToken = machine.inputToken()
  assert.ok(machine.restoreCancelledPrompt(request))
  assert.equal(machine.markCancelRestoreCommitted(cancellation.settlement), true)
  assert.equal(machine.settleCancel(cancellation.settlement, { uiSettled: true, cancelRequestSettled: true }), true)
  assert.notEqual(machine.inputToken(), oldRenderToken)

  let writeBusy = false
  const executed = []
  const guardedWriteEntry = (name, inputToken) => {
    if (inputToken !== machine.inputToken()) return false
    if (!canMutateProductInput({ aiActive: machine.isLocked(), busy: '', requestLocked: false, writeLocked: writeBusy })) return false
    writeBusy = true
    executed.push(name)
    return true
  }
  const entries = ['initializeLibrary', 'completeConnection', 'applyTakeover', 'rollbackTakeover', 'confirmRollback', 'createMergeDraft', 'createLibraryDraft', 'confirmFile', 'commitUpdate']
  for (const name of entries) assert.equal(guardedWriteEntry(name, oldRenderToken), false, `${name} must reject an old render token after unlock`)
  const newRenderToken = machine.inputToken()
  for (const name of entries) {
    assert.equal(guardedWriteEntry(name, newRenderToken), true, `${name} must accept the current render token`)
    assert.equal(guardedWriteEntry(`${name}-same-tick-second`, newRenderToken), false, `${name} must reject a second same-token write while reserved`)
    writeBusy = false
  }
  assert.deepEqual(executed, entries)
})

test('successful library and takeover writes release before success navigation', () => {
  for (const operation of ['initializeLibrary', 'applyTakeover', 'rollbackTakeover']) {
    const start = app.indexOf(`const ${operation} = useCallback`)
    const end = app.indexOf('\n  const ', start + 1)
    assert.ok(start >= 0 && end > start, `${operation} handler must be present`)
    const body = app.slice(start, end)
    const releaseAt = body.indexOf('writeBusyRef.current = false')
    const clearBusyAt = body.indexOf('busyRef.current = ""')
    const navigateAt = body.indexOf('navigate(')
    assert.ok(releaseAt >= 0 && clearBusyAt > releaseAt && navigateAt > clearBusyAt, `${operation} must release and clear busy before navigating`)
  }

  const runSuccessBoundary = (operation) => {
    let writeLocked = true
    let busy = operation
    const events = []
    const navigate = () => {
      const allowed = canNavigateProduct({ aiActive: false, busy, requestLocked: false, writeLocked })
      events.push(allowed ? 'navigate-allowed' : 'navigate-blocked')
      return allowed
    }

    const unfinished = navigate()
    events.push('write-failed')
    const failed = navigate()
    events.push('authoritative-state-updated')
    writeLocked = false
    busy = ''
    events.push('write-released')
    const completed = navigate()
    return { unfinished, failed, completed, events }
  }

  for (const operation of ['initializeLibrary', 'applyTakeover', 'rollbackTakeover']) {
    const result = runSuccessBoundary(operation)
    assert.equal(result.unfinished, false, `${operation} must reject navigation while write is unfinished`)
    assert.equal(result.failed, false, `${operation} must reject navigation after an incomplete/failed write`)
    assert.equal(result.completed, true, `${operation} must allow navigation after write release`)
    assert.deepEqual(result.events, ['navigate-blocked', 'write-failed', 'navigate-blocked', 'authoritative-state-updated', 'write-released', 'navigate-allowed'])
  }
})

test('persisted selection never falls through an ambiguous stable signal', () => {
  const reference = {
    id: 'old-rest',
    sourcePath: 'workspace',
    fingerprint: 'unique-rest-fingerprint',
    paths: ['skills/demo/SKILL.md'],
  }
  const candidates = [
    { id: 'rest-a', sourceKeys: ['workspace'], fingerprint: 'other-a', paths: ['skills/demo/SKILL.md'] },
    { id: 'rest-b', sourceKeys: ['workspace'], fingerprint: 'other-b', paths: ['skills/demo/SKILL.md'] },
    { id: 'cli', sourceKeys: ['other'], fingerprint: 'unique-rest-fingerprint', paths: ['skills/other/SKILL.md'] },
  ]
  const result = resolvePersistedSelectionReference(reference, candidates)
  assert.equal(result.match, null)
  assert.match(result.reason, /不唯一/u)
  assert.deepEqual(result.candidates, ['rest-a', 'rest-b'])

  const unique = resolvePersistedSelectionReference({ ...reference, sourcePath: 'other', paths: ['skills/other/SKILL.md'] }, candidates)
  assert.equal(unique.match.id, 'cli')
})

test('analysis failure is terminal and recovery stays in the flow', () => {
  assert.equal(analysisViewMode({ hasFailure: true, busy: true }), 'failed')
  assert.equal(analysisViewMode({ hasFailure: false, busy: true }), 'running')
  assert.equal(analysisRecoveryRoute('initialize'), 'welcome')
  assert.equal(analysisRecoveryRoute('connect'), 'connect-select')
  assert.equal(analysisRecoveryRoute('update'), 'workspaces')
  assert.equal(normalizedAnalysisRetryPath('  C:\\workspace  '), 'C:\\workspace')
})

test('takeover apply preserves the approved paths while the request is busy', () => {
  const approved = { operations: [{ path: 'skills/demo/SKILL.md' }], planHash: 'approved', targetProjection: '.agents/skills' }
  const applied = preserveApprovedTakeoverPreview(approved, { status: 'applying', operations: [] })
  assert.equal(applied.status, 'applying')
  assert.deepEqual(applied.operations, approved.operations)
  assert.equal(applied.planHash, 'approved')
})

test('takeover summary collapses leaf operations into a Chinese directory card', () => {
  const operations = Array.from({ length: 143 }, (_, index) => ({
    path: `skills/unity-skills/references/${String(index + 1).padStart(3, '0')}.md`,
    targetPath: `.agents/skills/unity-skills/references/${String(index + 1).padStart(3, '0')}.md`,
    canonicalTarget: 'C:\\workspace\\.agents\\skills\\unity-skills',
    projection: '.agents/skills',
    action: 'keep',
    available: true,
  }))
  const preview = { planHash: 'keep-plan', operations }
  const summary = takeoverSummaryModel(preview)

  assert.equal(summary.groups.length, 1)
  assert.equal(summary.groups[0].name, 'unity-skills')
  assert.equal(summary.groups[0].total, 143)
  assert.equal(summary.groups[0].keep, 143)
  assert.equal(summary.groups[0].create, 0)
  assert.equal(summary.groups[0].update, 0)
  assert.equal(summary.advancedItems.length, 143)
  assert.ok(summary.advancedItems.every((item) => item.action === 'keep'))
  assert.ok(summary.advancedItems.every((item) => item.actionLabel === '无需改动'))
  assert.doesNotMatch(JSON.stringify(summary.groups), /references\/001\.md/u)
  assert.deepEqual(preview.operations, operations, 'presentation model must not rewrite the apply preview')
})

test('takeover summary keeps mixed create/update/keep counts in one directory and blocks unavailable leaves', () => {
  const preview = {
    planHash: 'mixed-plan',
    operations: [
      { path: 'skills/unity-skills/a.md', targetPath: '.agents/skills/unity-skills/a.md', canonicalTarget: 'C:\\workspace\\.agents\\skills\\unity-skills', projection: '.agents/skills', action: 'create', available: true },
      { path: 'skills/unity-skills/b.md', targetPath: '.agents/skills/unity-skills/b.md', canonicalTarget: 'C:\\workspace\\.agents\\skills\\unity-skills', projection: '.agents/skills', action: 'update', available: true },
      { path: 'skills/unity-skills/c.md', targetPath: '.agents/skills/unity-skills/c.md', canonicalTarget: 'C:\\workspace\\.agents\\skills\\unity-skills', projection: '.agents/skills', action: 'keep', available: true },
      { path: 'skills/unity-skills/blocked.md', targetPath: '.agents/skills/unity-skills/blocked.md', canonicalTarget: 'C:\\workspace\\.agents\\skills\\unity-skills', projection: '.agents/skills', action: 'unavailable', available: false },
    ],
  }
  const summary = takeoverSummaryModel(preview)

  assert.equal(summary.groups.length, 1)
  assert.deepEqual(summary.groups[0], {
    key: 'canonical:c:/workspace/.agents/skills/unity-skills',
    name: 'unity-skills',
    canonicalTarget: 'C:\\workspace\\.agents\\skills\\unity-skills',
    projection: '.agents/skills',
    total: 3,
    create: 1,
    update: 1,
    keep: 1,
  })
  assert.equal(summary.advancedItems.length, 3)
  assert.equal(summary.unavailable.length, 1)
  assert.deepEqual(summary.advancedItems.map((item) => item.actionLabel), ['新建', '更新', '无需改动'])
})

test('takeover panel renders directory groups in the main card and leaves only advanced items for leaf details', () => {
  const start = app.indexOf('const renderTakeoverV2 = () =>')
  const end = app.indexOf('const previewRollback = useCallback', start)
  assert.ok(start >= 0 && end > start)
  const takeover = app.slice(start, end)
  assert.match(takeover, /takeoverSummaryModel\(preview\)/u)
  assert.match(takeover, /summary\.groups\.map/u)
  assert.match(takeover, /summary\.advancedItems\.map/u)
  assert.doesNotMatch(takeover, /entries\.map/u)
  assert.doesNotMatch(takeover, /dict\(entry\)\.action/u)
  assert.doesNotMatch(takeover, /dict\(entry\)\.path/u)
  assert.match(takeover, /查看实际写入路径（高级诊断）/u)
})

test('product panel layout rules keep long paths and compact review cards readable', () => {
  for (const token of [
    'overflow-wrap: break-word',
    'word-break: normal',
    '.github-diff-line',
    '.result-ai-composer',
    '.success-card',
    '.analysis-failure',
    'position: fixed',
  ]) {
    assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), `missing layout contract: ${token}`)
  }
  const body = cssDeclarations('body')
  const diff = cssDeclarations('.github-diff')
  const diffLine = cssDeclarations('.github-diff-line')
  const diffCode = cssDeclarations('.github-diff-line code')
  const diffFile = cssDeclarations('.diff-file')
  const reviewMain = cssDeclarations('.update-review-main')
  assert.equal(body['overflow-x'], 'clip', 'the page must not become the horizontal scroll container')
  assert.equal(diff.width, '100%')
  assert.equal(diff['max-width'], '100%')
  assert.equal(diff['min-width'], '0')
  assert.equal(diff['overflow-x'], 'auto', 'long lines must scroll inside the diff container')
  assert.equal(diff['overflow-y'], 'hidden')
  assert.equal(diffLine.width, 'max-content', 'a diff row may grow to its content width')
  assert.equal(diffLine['min-width'], '100%', 'short rows still fill the diff viewport')
  assert.equal(diffLine['grid-template-columns'], '42px 42px 25px max-content')
  assert.equal(diffLine['font-size'], '12px', 'diff line numbers and body must stay readable')
  assert.equal(diffCode.width, 'max-content')
  assert.equal(diffCode['white-space'], 'pre')
  assert.equal(diffFile['max-width'], '100%')
  assert.equal(diffFile['min-width'], '0')
  assert.equal(reviewMain['max-width'], '100%')
  assert.equal(reviewMain['min-width'], '0')
  assert.doesNotMatch(css, /\.github-diff-line\s*\{[^}]*min-width:\s*max-content/iu, 'the row itself must not escape its scroll container')
  assert.match(css, /\.compare-layout > \*/, 'diff layout must allow the AI side panel to keep its width')
  assert.match(css, /\.result-ai-file-list \{ display: grid; grid-template-columns: minmax\(0,1fr\)/u)
  assert.doesNotMatch(css, /\.manual-path-fallback \{ position: relative/u, 'fallback drawer must stay viewport anchored')
  assert.match(app, /!activeFile\?\.contentLoaded/u, 'reload/search must auto-load the selected file body')
  assert.match(app, /className="github-diff"/u, 'diff rows must render inside the constrained scroll container')
})

test('Round 011 desktop homepage copy and path/status surfaces stay at readable size without widening the root', () => {
  for (const selector of [
    '.profile-chip > span', '.profile-chip strong', '.profile-chip small', '.global-search kbd', '.home-card-label',
    '.home-skill-count > .home-card-label', '.workspace-row .workspace-avatar',
    '.home-update-copy p', '.home-skill-count p', '.home-ai-card p', '.home-ai-form input',
    '.workspace-row code', '.workspace-row .status-pill', '.empty-workspace strong', '.empty-workspace p',
    '.principles-strip small', '.global-search-results small',
  ]) {
    assert.equal(cssDeclarations(selector)['font-size'], '12px', `${selector} must be readable on the desktop homepage`)
  }
  assert.match(css, /\.app-shell,[\s\S]*\.workspace-row > div \{[\s\S]*min-width: 0/u)
  assert.equal(cssDeclarations('body')['overflow-x'], 'clip')
})

test('product panel keeps rollback and deletion on explicit human-review paths', () => {
  assert.match(app, /rollbackPreview\(/u)
  assert.match(app, /confirm: true/u)
  assert.match(app, /确认并生成回滚版本/u)
  assert.match(app, /AI 未返回文件正文/u)
  assert.match(app, /直接进入人工审阅/u)
  assert.match(app, /filePath, file\.originPath, file\.path/u)
  assert.doesNotMatch(app, /window\.confirm\([^)]*回滚/u)
})

test('product panel keeps raw transport details behind a safe Chinese recovery message', () => {
  const rawPath = 'C:\\secret\\unknown-result.json'
  const unknown = formatProductError({
    code: 'UNEXPECTED_PROVIDER_FAILURE',
    status: 502,
    message: `provider failed at ${rawPath}`,
    data: { error: { code: 'UNEXPECTED_PROVIDER_FAILURE', message: `provider failed at ${rawPath}` } },
  })
  assert.match(unknown.message, /操作|重试/u)
  assert.doesNotMatch(unknown.message, /secret|provider failed|unknown-result/u)
  assert.match(unknown.technical, /secret|unknown-result/u)

  const malformed = formatProductError({ data: { raw: '<!doctype html>' } })
  assert.match(malformed.message, /操作|重试/u)
  assert.doesNotMatch(malformed.message, /doctype|html/u)
  assert.match(malformed.technical, /doctype|html/u)

  for (const code of ['PRODUCT_TAKEOVER_TOPOLOGY_CONFLICT', 'PRODUCT_ROLLBACK_TOPOLOGY_CONFLICT']) {
    const topologyConflict = formatProductError({ code, message: 'C:\\private\\canonical' })
    assert.match(topologyConflict.message, /Junction|别名/u)
    assert.match(topologyConflict.message, /停止/u)
    assert.doesNotMatch(topologyConflict.message, /private|canonical/u)
    assert.match(topologyConflict.technical, /private|canonical/u)
  }
})
