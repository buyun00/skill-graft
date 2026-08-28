import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { createProductService } from '../server/product-service.mjs'

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

function makeWorkspace(root, skill = '# demo skill\n') {
  const workspace = path.join(root, 'workspace')
  writeFile(path.join(workspace, '.agents', 'skills', 'demo', 'SKILL.md'), skill)
  writeFile(path.join(workspace, '.agents', 'skills', 'cache-control', 'SKILL.md'), '# legal cache-control skill\n')
  writeFile(path.join(workspace, '.agents', 'skills', 'backup-plans', 'SKILL.md'), '# legal backup-plans skill\n')
  writeFile(path.join(workspace, '.agents', 'skills', 'cache', 'SKILL.md'), '# legal cache skill\n')
  writeFile(path.join(workspace, '.agents', 'skills', 'backup', 'SKILL.md'), '# legal backup skill\n')
  writeFile(path.join(workspace, '.agents', 'skills', 'demo', '__pycache__', 'module.pyc'), 'compiled-cache')
  writeFile(path.join(workspace, 'PackageCache', 'package.json'), '{"cache":true}\n')
  writeFile(path.join(workspace, 'backup', 'old.txt'), 'backup evidence\n')
  return workspace
}

function git(workspace, args) {
  return execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function makeDormantWorkspace(root, count = 121) {
  const workspace = path.join(root, 'dormant-workspace')
  for (let index = 1; index <= count; index += 1) {
    writeFile(path.join(workspace, '.agents', 'skills', `missing-${String(index).padStart(3, '0')}`, 'SKILL.md'), `# missing ${index}\n`)
  }
  git(workspace, ['init', '--quiet'])
  git(workspace, ['add', '.'])
  const paths = []
  for (let index = 1; index <= count; index += 1) {
    paths.push(`.agents/skills/missing-${String(index).padStart(3, '0')}/SKILL.md`)
  }
  git(workspace, ['update-index', '--skip-worktree', '--', ...paths])
  for (const relative of paths) fs.rmSync(path.join(workspace, ...relative.split('/')), { force: true })
  return workspace
}

function makeNestedWorkspace(root, skill = '# nested demo skill\n') {
  const workspace = path.join(root, 'nested-workspace')
  writeFile(path.join(workspace, '.agents', 'skills', 'unity-skills', 'demo', 'SKILL.md'), skill)
  writeFile(path.join(workspace, '.agents', 'skills', 'unity-skills', 'cache-control', 'SKILL.md'), '# legal nested cache-control skill\n')
  writeFile(path.join(workspace, '.agents', 'skills', 'unity-skills', 'backup-plans', 'SKILL.md'), '# legal nested backup-plans skill\n')
  return workspace
}

function makeHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-product-'))
  const workspace = options.nested ? makeNestedWorkspace(root, options.skill) : makeWorkspace(root, options.skill)
  const service = createProductService({
    packageRoot: process.cwd(),
    dataRoot: path.join(root, 'data'),
    executeTyped: options.executeTyped
  })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const call = (method, pathname, body = {}, query = {}) => service.handle({
    method,
    pathname,
    body,
    searchParams: new URLSearchParams(query)
  })
  return { root, workspace, service, call }
}

async function initialize(harness) {
  const analysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const system = analysis.systems.find((item) => item.selectable && item.files.some((file) => /SKILL\.md$/iu.test(file.path)))
  assert.ok(system, 'analysis should expose a selectable Skill system')
  const initialized = await harness.call('POST', '/library/initialize', {
    workspacePath: harness.workspace,
    analysisId: analysis.analysisId,
    selectedSystems: [system.id],
    acknowledgeProtection: true
  })
  const skillPath = system.files.find((file) => file.path === 'skills/demo/SKILL.md')?.path
    || system.files.find((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path))?.path
  assert.ok(skillPath, 'initialized system should expose a Skill path')
  return { analysis, system, initialized, planId: initialized.plan.planId, skillPath }
}

test('product gate keeps caches as evidence and requires explicit v1 protection acknowledgement', async (t) => {
  const harness = makeHarness(t)
  const analysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const evidence = analysis.systems.flatMap((system) => system.files).filter((file) => file.evidenceOnly || file.artifactKind)
  assert.ok(evidence.some((file) => /(?:pyc|pycache|packagecache|backup)/iu.test(`${file.path} ${file.artifactReason}`)))
  const storedPaths = analysis.systems.flatMap((system) => system.files.filter((file) => file.stored).map((file) => file.path))
  assert.ok(storedPaths.includes('skills/cache-control/SKILL.md'))
  assert.ok(storedPaths.includes('skills/backup-plans/SKILL.md'))
  assert.ok(storedPaths.includes('skills/cache/SKILL.md'))
  assert.ok(storedPaths.includes('skills/backup/SKILL.md'))
  assert.ok(!evidence.some((file) => /skills\/(?:cache-control|backup-plans|cache|backup)\/SKILL\.md$/iu.test(file.path)))
  assert.ok(!analysis.systems.some((system) => system.selectable && /缓存|备份/iu.test(system.name)))
  const system = analysis.systems.find((item) => item.selectable && item.files.some((file) => /SKILL\.md$/iu.test(file.path)))
  await assert.rejects(
    harness.call('POST', '/library/initialize', { analysisId: analysis.analysisId, selectedSystems: [system.id] }),
    (error) => error.code === 'PRODUCT_PROTECTION_ACK_REQUIRED',
  )
  const initialized = await harness.call('POST', '/library/initialize', {
    analysisId: analysis.analysisId,
    selectedSystems: [system.id],
    acknowledgeProtection: true
  })
  const library = await harness.call('GET', '/library')
  assert.equal(initialized.version.versionId, 'v1')
  assert.ok(library.current.files.length > 0)
  assert.ok(library.current.files.some((file) => file.path === 'skills/cache-control/SKILL.md'))
  assert.ok(library.current.files.some((file) => file.path === 'skills/backup-plans/SKILL.md'))
  assert.ok(library.current.files.every((file) => file.path !== 'backup/old.txt' && !/(?:^|\/)PackageCache(?:\/|$)/iu.test(file.path) && !/\.(?:pyc|pyo)$/iu.test(file.path)))
})

test('an isolated derived cache file stays visible as evidence without a cache directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-isolated-cache-'))
  const workspace = path.join(root, 'workspace')
  writeFile(path.join(workspace, '.agents', 'skills', 'demo', 'SKILL.md'), '# demo\n')
  writeFile(path.join(workspace, '.agents', 'skills', 'demo', 'compiled.pyc'), 'compiled')
  const service = createProductService({ packageRoot: process.cwd(), dataRoot: path.join(root, 'data') })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const analysis = await service.handle({ method: 'POST', pathname: '/analyze', body: { workspacePath: workspace }, searchParams: new URLSearchParams() })
  const evidence = analysis.systems.flatMap((system) => system.files).find((file) => file.path.endsWith('/compiled.pyc'))
  assert.ok(evidence)
  assert.equal(evidence.evidenceOnly, true)
  assert.equal(evidence.stored, false)
})

test('center library create/delete flows preview and save immutable new versions, with searchable sources', async (t) => {
  const harness = makeHarness(t)
  const { planId, skillPath } = await initialize(harness)
  const created = await harness.call('POST', '/library/draft', {
    planId,
    action: 'create',
    path: 'skills/new/README.md',
    content: '# new file\n'
  })
  assert.equal(created.action, 'create')
  assert.equal(created.preview.targetPath, 'skills/new/README.md')
  const createdDraft = await harness.call('GET', '/draft', {}, { draftId: created.draftId })
  assert.equal(createdDraft.files[0].content, '# new file\n')
  await harness.call('POST', '/draft/confirm', { draftId: created.draftId, path: 'skills/new/README.md', confirmed: true })
  const v2 = await harness.call('POST', '/draft/commit', { draftId: created.draftId, message: '新建代表文件' })
  assert.equal(v2.version.versionId, 'v2')
  const createdSearch = await harness.call('GET', '/search', {}, { q: 'skills/new/README.md' })
  assert.ok(createdSearch.results.some((item) => item.type === 'file' && item.title === 'skills/new/README.md'))

  const deleted = await harness.call('POST', '/library/draft', { planId, action: 'delete', path: 'skills/new/README.md' })
  assert.equal(deleted.action, 'delete')
  assert.match(deleted.preview.title, /删除/iu)
  assert.equal(deleted.files[0].originalContent, '# new file\n')
  assert.equal(deleted.files[0].originalContentAvailable, true)
  await harness.call('POST', '/draft/confirm', { draftId: deleted.draftId, path: 'skills/new/README.md', confirmed: true })
  const v3 = await harness.call('POST', '/draft/commit', { draftId: deleted.draftId, message: '删除代表文件' })
  assert.equal(v3.version.versionId, 'v3')
  const library = await harness.call('GET', '/library')
  assert.ok(library.current.files.some((file) => file.path === skillPath))
  assert.ok(!library.current.files.some((file) => file.path === 'skills/new/README.md'))
  assert.ok(library.plan.sourceSystems.length > 0)
  const source = await harness.call('GET', '/library/source', {}, { planId, systemId: library.plan.sourceSystems[0].id })
  assert.ok(source.source.path)
  assert.ok(source.files.some((file) => file.path === skillPath && file.readOnly === true))
  const sourceBody = await harness.call('GET', '/library/source', {}, { planId, systemId: library.plan.sourceSystems[0].id, filePath: skillPath })
  assert.equal(sourceBody.readOnly, true)
  assert.equal(sourceBody.file.path, skillPath)
  assert.match(sourceBody.file.content, /demo skill/iu)
  const removedSearch = await harness.call('GET', '/search', {}, { q: 'skills/new/README.md' })
  assert.ok(!removedSearch.results.some((item) => item.type === 'file' && item.title === 'skills/new/README.md'))
})

test('deleted tombstone accepts the page original echo, keeps deletion non-editable, and commits', async (t) => {
  const harness = makeHarness(t)
  const { planId, system, skillPath } = await initialize(harness)
  fs.rmSync(path.join(harness.workspace, '.agents', 'skills', 'demo', 'SKILL.md'))
  const analysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const comparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: analysis.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [system.id]
  })
  const draft = await harness.call('POST', '/library/draft', {
    comparisonId: comparison.comparisonId,
    planId,
    paths: [skillPath],
    origin: 'workspace-review'
  })
  const tombstone = draft.files.find((file) => file.path === skillPath)
  assert.equal(tombstone.deleted, true)
  assert.equal(tombstone.aiEditable, false, 'a tombstone may be reviewed by AI but its body is never AI-editable')
  assert.equal(tombstone.originalContentAvailable, true)
  assert.match(tombstone.originalContent, /demo skill/iu)

  // The browser sends the currently displayed original body with the delete
  // confirmation. It is an echo for review, not an edit to the tombstone.
  const confirmed = await harness.call('POST', '/draft/confirm', {
    draftId: draft.draftId,
    path: skillPath,
    originalContent: tombstone.originalContent,
    confirmed: true
  })
  assert.equal(confirmed.allConfirmed, true)
  await assert.rejects(
    harness.call('POST', '/draft/file', { draftId: draft.draftId, path: skillPath, content: '# attempted edit\n' }),
    (error) => error.code === 'PRODUCT_FILE_NOT_EDITABLE'
  )

  const committed = await harness.call('POST', '/draft/commit', { draftId: draft.draftId, message: '删除并确认原文回显' })
  assert.equal(committed.version.versionId, 'v2')
  assert.ok(!committed.version.files.some((file) => file.path === skillPath))
})

test('library search has explicit hit and empty results while file reload returns the selected body', async (t) => {
  const harness = makeHarness(t)
  const { planId, skillPath } = await initialize(harness)
  const hit = await harness.call('GET', '/search', {}, { q: skillPath })
  assert.ok(hit.results.some((item) => item.type === 'file' && item.title === skillPath))
  const empty = await harness.call('GET', '/search', {}, { q: 'no-such-library-file-9f2a' })
  assert.deepEqual(empty.results, [])
  const reloaded = await harness.call('GET', '/library/file', {}, { planId, version: 'v1', path: skillPath })
  assert.equal(reloaded.path, skillPath)
  assert.match(reloaded.content, /demo skill/iu)
})

test('one confirm request persists the focused editor snapshot and confirms that exact content', async (t) => {
  const harness = makeHarness(t)
  const { planId, skillPath } = await initialize(harness)
  const draft = await harness.call('POST', '/library/draft', { planId, action: 'edit', path: skillPath })
  const focusedContent = '# one real click content\n'
  const confirmed = await harness.call('POST', '/draft/confirm', {
    draftId: draft.draftId,
    path: skillPath,
    content: focusedContent,
    finalContent: focusedContent,
    confirmed: true,
  })
  assert.equal(confirmed.confirmedCount, 1)
  assert.equal(confirmed.allConfirmed, true)
  const readback = await harness.call('GET', '/draft', {}, { draftId: draft.draftId, path: skillPath })
  assert.equal(readback.file.content, focusedContent)
  assert.equal(readback.file.confirmed, true)
})

test('center delete preview fails closed when the current version body is unavailable', async (t) => {
  const harness = makeHarness(t)
  const { planId } = await initialize(harness)
  const created = await harness.call('POST', '/library/draft', {
    planId,
    action: 'create',
    path: 'skills/missing-body/README.md',
    content: '# body that will be removed\n'
  })
  await harness.call('POST', '/draft/confirm', { draftId: created.draftId, path: 'skills/missing-body/README.md', confirmed: true })
  await harness.call('POST', '/draft/commit', { draftId: created.draftId })
  const bodyPath = path.join(harness.root, 'data', 'product', 'library', planId, 'versions', 'v2', 'files', 'skills', 'missing-body', 'README.md')
  fs.rmSync(bodyPath)
  await assert.rejects(
    harness.call('POST', '/library/draft', { planId, action: 'delete', path: 'skills/missing-body/README.md' }),
    (error) => error.code === 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE',
  )
})

test('a manifest-declared missing center body fail-closes every draft and version-save path before creating a version', async (t) => {
  const harness = makeHarness(t)
  const { planId, skillPath } = await initialize(harness)
  const firstDraft = await harness.call('POST', '/library/draft', { planId, action: 'edit', path: skillPath })
  await harness.call('POST', '/draft/file', { draftId: firstDraft.draftId, path: skillPath, content: '# v2 before the body is removed\n' })
  await harness.call('POST', '/draft/confirm', { draftId: firstDraft.draftId, path: skillPath, confirmed: true })
  await harness.call('POST', '/draft/commit', { draftId: firstDraft.draftId, message: 'create v2 for missing-body gate' })

  const pendingDraft = await harness.call('POST', '/library/draft', { planId, action: 'edit', path: skillPath })
  await harness.call('POST', '/draft/confirm', { draftId: pendingDraft.draftId, path: skillPath, confirmed: true })
  const pendingDeleteDraft = await harness.call('POST', '/library/draft', { planId, action: 'delete', path: skillPath })
  const rollbackPreview = await harness.call('POST', '/version/rollback/preview', { planId, versionId: 'v1' })
  const bodyPath = path.join(harness.root, 'data', 'product', 'library', planId, 'versions', 'v2', 'files', ...skillPath.split('/'))
  fs.rmSync(bodyPath)

  const expectMissingBody = (promise) => assert.rejects(
    promise,
    (error) => {
      assert.equal(error.code, 'PRODUCT_CURRENT_VERSION_CONTENT_UNAVAILABLE')
      assert.match(error.message, /当前中心库版本正文不可用/iu)
      assert.ok(error.details?.paths?.includes(skillPath))
      return true
    },
  )
  await expectMissingBody(harness.call('POST', '/library/draft', { planId, action: 'edit', path: skillPath }))
  await assert.rejects(
    harness.call('POST', '/library/draft', { planId, action: 'delete', path: skillPath }),
    (error) => error.code === 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE',
  )
  await expectMissingBody(harness.call('POST', '/draft/file', { draftId: pendingDraft.draftId, path: skillPath, content: '# blocked\n' }))
  await expectMissingBody(harness.call('POST', '/draft/confirm', { draftId: pendingDraft.draftId, path: skillPath, confirmed: false }))
  await assert.rejects(
    harness.call('POST', '/draft/confirm', { draftId: pendingDeleteDraft.draftId, path: skillPath, confirmed: true }),
    (error) => error.code === 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE',
  )
  await expectMissingBody(harness.call('POST', '/draft/ai', { draftId: pendingDraft.draftId, message: '整理说明', selectedFiles: [skillPath] }))
  await expectMissingBody(harness.call('POST', '/draft/commit', { draftId: pendingDraft.draftId, message: 'must not create v3' }))
  await expectMissingBody(harness.call('POST', '/version/rollback/preview', { planId, versionId: 'v1' }))
  await expectMissingBody(harness.call('POST', '/version/rollback', { previewId: rollbackPreview.previewId, planHash: rollbackPreview.planHash, confirm: true }))

  const library = await harness.call('GET', '/library')
  assert.equal(library.plan.currentVersion, 'v2')
  assert.deepEqual(library.plan.versions.map((item) => item.versionId), ['v1', 'v2'])
})

test('library source opens every selected origin by filePath with complete read-only content', async (t) => {
  const harness = makeHarness(t)
  const { planId } = await initialize(harness)
  const library = await harness.call('GET', '/library')
  const system = library.plan.sourceSystems[0]
  const source = await harness.call('GET', '/library/source', {}, { planId, systemId: system.id })
  assert.ok(source.files.length >= 5, 'source contract should retain all selected files, not only system metadata')
  for (const descriptor of source.files) {
    assert.ok(descriptor.originPath)
    assert.equal(descriptor.filePath, descriptor.originPath)
    assert.ok(descriptor.analysisId)
    assert.equal(descriptor.readOnly, true)
    const opened = await harness.call('GET', '/library/source', {}, { planId, systemId: system.id, filePath: descriptor.filePath })
    assert.equal(opened.file.path, descriptor.path)
    assert.equal(opened.file.filePath, descriptor.filePath)
    assert.equal(opened.file.originPath, descriptor.originPath)
    assert.equal(opened.file.contentLoaded, true)
    assert.equal(typeof opened.file.content, 'string')
    assert.ok(opened.file.content.length > 0, `source body should be loaded for ${descriptor.path}`)
  }
})

test('connected comparisons use baseline/center/workspace direction and do not flag center-only updates as workspace changes', async (t) => {
  const harness = makeHarness(t)
  const { planId, system, skillPath } = await initialize(harness)
  const centerDraft = await harness.call('POST', '/library/draft', { planId, action: 'edit', path: skillPath })
  await harness.call('POST', '/draft/file', { draftId: centerDraft.draftId, path: skillPath, content: '# center-only change\n' })
  await harness.call('POST', '/draft/confirm', { draftId: centerDraft.draftId, path: skillPath, confirmed: true })
  await harness.call('POST', '/draft/commit', { draftId: centerDraft.draftId, message: '中心库单边更新' })

  const unchangedAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const centerOnly = await harness.call('POST', '/compare', {
    planId,
    analysisId: unchangedAnalysis.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [system.id]
  })
  assert.equal(centerOnly.summary.workspaceChanged, 0)
  assert.ok(centerOnly.files.some((file) => file.direction === 'center-only'))
  const overviewAfterCenterOnly = await harness.call('GET', '/overview')
  assert.equal(overviewAfterCenterOnly.workspaces[0].hasUpdates, false)

  writeFile(path.join(harness.workspace, '.agents', 'skills', 'demo', 'SKILL.md'), '# workspace and center differ\n')
  const changedAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const conflict = await harness.call('POST', '/compare', {
    planId,
    analysisId: changedAnalysis.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [system.id]
  })
  assert.equal(conflict.summary.workspaceChanged, 1)
  assert.equal(conflict.summary.conflicts, 1)
  assert.equal(conflict.files.find((file) => file.path === skillPath).direction, 'conflict')
})

test('update scope excludes center-only files and drafts/commits only selected file paths', async (t) => {
  const harness = makeHarness(t)
  const { planId, system, skillPath } = await initialize(harness)
  const centerOnlyPath = 'skills/center-only/README.md'
  const centerDraft = await harness.call('POST', '/library/draft', {
    planId,
    action: 'create',
    path: centerOnlyPath,
    content: '# center-only\n'
  })
  await harness.call('POST', '/draft/confirm', { draftId: centerDraft.draftId, path: centerOnlyPath, confirmed: true })
  await harness.call('POST', '/draft/commit', { draftId: centerDraft.draftId, message: '保存中心库单边文件' })

  fs.rmSync(path.join(harness.workspace, '.agents', 'skills', 'demo', 'SKILL.md'))
  const deletedAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const deletedComparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: deletedAnalysis.analysisId,
    workspacePath: harness.workspace,
    mode: 'update',
    selectedSystems: [system.id]
  })
  assert.ok(deletedComparison.files.some((file) => file.path === skillPath && file.direction === 'workspace-only'))
  assert.ok(!deletedComparison.files.some((file) => file.path === centerOnlyPath), 'center-only library content must not become a workspace deletion')

  const deletionDraft = await harness.call('POST', '/library/draft', {
    comparisonId: deletedComparison.comparisonId,
    planId,
    paths: [skillPath],
    origin: 'workspace-review'
  })
  assert.deepEqual(deletionDraft.files.map((file) => file.path), [skillPath], 'draft files must equal selected paths')
  await harness.call('POST', '/draft/confirm', { draftId: deletionDraft.draftId, path: skillPath, confirmed: true })
  await harness.call('POST', '/draft/commit', { draftId: deletionDraft.draftId, message: '删除工作区文件' })
  const afterDelete = await harness.call('GET', '/library')
  assert.ok(afterDelete.current.files.some((file) => file.path === centerOnlyPath), 'unselected center-only file must survive the selected deletion commit')
  assert.ok(!afterDelete.current.files.some((file) => file.path === skillPath))

  writeFile(path.join(harness.workspace, '.agents', 'skills', 'demo', 'SKILL.md'), '# restored demo skill\n')
  const restoredAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const restoredComparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: restoredAnalysis.analysisId,
    workspacePath: harness.workspace,
    mode: 'update',
    selectedSystems: [system.id]
  })
  assert.ok(restoredComparison.files.some((file) => file.path === skillPath && file.direction === 'workspace-only'))
  assert.ok(!restoredComparison.files.some((file) => file.path === centerOnlyPath), 'restored workspace analysis must not reverse-mark center-only content')
})

test('durable selected refs survive delete-save-restore reanalysis and settle to a zero-diff no-op', async (t) => {
  const harness = makeHarness(t)
  const { planId, system, skillPath } = await initialize(harness)
  const centerOnlyPaths = ['skills/center-only/SKILL.md', 'rules/center-only.md']
  for (const centerOnlyPath of centerOnlyPaths) {
    const centerDraft = await harness.call('POST', '/library/draft', {
      planId,
      action: 'create',
      path: centerOnlyPath,
      content: `# ${centerOnlyPath}\n`
    })
    await harness.call('POST', '/draft/confirm', { draftId: centerDraft.draftId, path: centerOnlyPath, confirmed: true })
    await harness.call('POST', '/draft/commit', { draftId: centerDraft.draftId, message: `保存 ${centerOnlyPath}` })
  }

  const sampleFile = path.join(harness.workspace, '.agents', 'skills', ...skillPath.split('/').slice(1))
  fs.rmSync(sampleFile, { force: true })
  const deletedAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const deletedComparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: deletedAnalysis.analysisId,
    workspacePath: harness.workspace,
    mode: 'update'
  })
  assert.deepEqual(deletedComparison.selectedSystemIds, [system.id])
  assert.deepEqual(deletedComparison.selectedSystemRefs.map((reference) => reference.id), [system.id])
  assert.ok(deletedComparison.selectedSystemRefs[0].paths.includes(skillPath), 'deleted path must remain in the durable scope')
  assert.ok(deletedComparison.files.some((file) => file.path === skillPath && file.direction === 'workspace-only'))
  for (const centerOnlyPath of centerOnlyPaths) {
    assert.ok(!deletedComparison.files.some((file) => file.path === centerOnlyPath), `${centerOnlyPath} must remain center-only`)
  }

  const deletionDraft = await harness.call('POST', '/library/draft', {
    comparisonId: deletedComparison.comparisonId,
    planId,
    paths: [skillPath],
    origin: 'workspace-review'
  })
  assert.deepEqual(deletionDraft.files.map((file) => file.path), [skillPath])
  await harness.call('POST', '/draft/confirm', { draftId: deletionDraft.draftId, path: skillPath, confirmed: true })
  await harness.call('POST', '/draft/commit', { draftId: deletionDraft.draftId, message: '保存删除后的工作区范围' })

  const afterDeleteOverview = await harness.call('GET', '/overview')
  const afterDeleteWorkspace = afterDeleteOverview.workspaces.find((item) => item.workspacePath === harness.workspace)
  assert.ok(afterDeleteWorkspace)
  const durableRef = afterDeleteWorkspace.selectedSystemRefs.find((reference) => reference.id === system.id)
  assert.ok(durableRef)
  for (const field of ['id', 'name', 'kind', 'sourcePath', 'canonicalTarget', 'fingerprint', 'contentHash', 'paths', 'projections']) {
    assert.ok(Object.prototype.hasOwnProperty.call(durableRef, field), `durable ref must keep ${field}`)
  }
  assert.ok(durableRef.paths.includes(skillPath), 'commit must not downgrade the durable path set to paths: []')
  assert.ok(Array.isArray(durableRef.projections))

  writeFile(sampleFile, '# demo skill\n')
  const restoredAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  assert.deepEqual(restoredAnalysis.workspace.selectedSystemIds, [system.id])
  assert.equal(restoredAnalysis.workspace.selectionNeedsReview, false)
  assert.ok(restoredAnalysis.workspace.selectedSystemRefs[0].paths.includes(skillPath))
  const restoredComparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: restoredAnalysis.analysisId,
    workspacePath: harness.workspace,
    mode: 'update'
  })
  assert.deepEqual(restoredComparison.files.map((file) => file.path), [skillPath], 'restore must produce only the sample workspace addition')
  assert.equal(restoredComparison.files[0].direction, 'workspace-only')
  assert.ok(restoredComparison.files.every((file) => !centerOnlyPaths.includes(file.path)))

  const restoreDraft = await harness.call('POST', '/library/draft', {
    comparisonId: restoredComparison.comparisonId,
    planId,
    paths: [skillPath],
    origin: 'workspace-review'
  })
  await harness.call('POST', '/draft/confirm', { draftId: restoreDraft.draftId, path: skillPath, confirmed: true })
  await harness.call('POST', '/draft/commit', { draftId: restoreDraft.draftId, message: '保存恢复后的工作区范围' })

  const noOpAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const noOpComparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: noOpAnalysis.analysisId,
    workspacePath: harness.workspace,
    mode: 'update'
  })
  assert.equal(noOpComparison.files.length, 0)
  assert.equal(noOpComparison.summary.workspaceChanged, 0)
  const completed = await harness.call('POST', '/workspace/complete-connection', {
    planId,
    analysisId: noOpAnalysis.analysisId,
    workspacePath: harness.workspace
  })
  assert.equal(completed.status, 'connected-noop')
  assert.equal(completed.version.created, false)
  assert.deepEqual(completed.workspace.selectedSystemIds, [system.id])
})

test('internal Junction projection is canonicalized and reversible while external projection is unavailable before confirmation', async (t) => {
  const harness = makeHarness(t)
  const { planId } = await initialize(harness)
  const takeoverRoot = path.join(harness.root, 'takeover-internal')
  const internal = path.join(takeoverRoot, 'internal-target')
  const internalSkills = path.join(internal, 'skills')
  fs.mkdirSync(internalSkills, { recursive: true })
  const internalLink = path.join(takeoverRoot, '.agents', 'skills')
  fs.mkdirSync(path.dirname(internalLink), { recursive: true })
  try {
    fs.symlinkSync(internalSkills, internalLink, 'junction')
  } catch {
    t.skip('Windows test host does not allow creating a Junction')
    return
  }
  const preview = await harness.call('POST', '/takeover/preview', { planId, worktreePath: path.dirname(path.dirname(internalLink)), targetProjection: '.agents/skills' })
  assert.equal(preview.available, true)
  assert.ok(preview.operations.every((operation) => operation.available !== false))
  assert.ok(preview.operations[0].targetPath.startsWith('internal-target/skills/'))
  const previewTargetFile = path.join(internalSkills, 'demo', 'SKILL.md')
  writeFile(previewTargetFile, '# changed after preview\n')
  await assert.rejects(
    harness.call('POST', '/takeover/apply', { previewId: preview.previewId, planHash: preview.planHash }),
    (error) => error.code === 'PRODUCT_PLAN_STALE',
    'a real target change after preview must remain fail-closed',
  )
  fs.rmSync(previewTargetFile)
  const applied = await harness.call('POST', '/takeover/apply', { previewId: preview.previewId, planHash: preview.planHash })
  assert.equal(applied.status, 'applied')
  assert.equal(fs.readFileSync(path.join(internalSkills, 'demo', 'SKILL.md'), 'utf8'), '# demo skill\n')
  assert.equal(fs.lstatSync(internalLink).isSymbolicLink(), true)
  await harness.call('POST', '/takeover/rollback', { protectionId: applied.protectionId })
  assert.equal(fs.existsSync(path.join(internalSkills, 'demo', 'SKILL.md')), false)

  const externalTarget = path.join(harness.root, 'external-target')
  fs.mkdirSync(path.join(externalTarget, 'skills'), { recursive: true })
  const externalLink = path.join(harness.root, 'takeover-external', '.agents', 'skills')
  fs.mkdirSync(path.dirname(externalLink), { recursive: true })
  fs.symlinkSync(path.join(externalTarget, 'skills'), externalLink, 'junction')
  const externalPreview = await harness.call('POST', '/takeover/preview', { planId, worktreePath: path.dirname(path.dirname(externalLink)), targetProjection: '.agents/skills' })
  assert.equal(externalPreview.available, false)
  assert.ok(externalPreview.unavailable.length > 0)
  await assert.rejects(
    harness.call('POST', '/takeover/apply', { previewId: externalPreview.previewId, planHash: externalPreview.planHash }),
    (error) => error.code === 'PRODUCT_TAKEOVER_UNSUPPORTED',
  )
})

test('takeover rollback preserves a pre-existing empty projection directory', async (t) => {
  const harness = makeHarness(t)
  const { planId } = await initialize(harness)
  const targetRoot = path.join(harness.root, 'takeover-empty-directory')
  const existingEmptyDirectory = path.join(targetRoot, '.agents', 'skills', 'demo')
  fs.mkdirSync(existingEmptyDirectory, { recursive: true })

  const preview = await harness.call('POST', '/takeover/preview', {
    planId,
    worktreePath: targetRoot,
    targetProjection: '.agents/skills'
  })
  const applied = await harness.call('POST', '/takeover/apply', {
    previewId: preview.previewId,
    planHash: preview.planHash
  })
  assert.equal(fs.readFileSync(path.join(existingEmptyDirectory, 'SKILL.md'), 'utf8'), '# demo skill\n')

  await harness.call('POST', '/takeover/rollback', { protectionId: applied.protectionId })
  assert.equal(fs.lstatSync(existingEmptyDirectory).isDirectory(), true)
  assert.deepEqual(fs.readdirSync(existingEmptyDirectory), [], 'rollback must not remove an empty directory that existed before takeover')
})

test('takeover rollback removes only directories created by this transaction in reverse depth order', async (t) => {
  const harness = makeHarness(t)
  const { planId } = await initialize(harness)
  const targetRoot = path.join(harness.root, 'takeover-created-directories')
  fs.mkdirSync(targetRoot, { recursive: true })
  const preview = await harness.call('POST', '/takeover/preview', {
    planId,
    worktreePath: targetRoot,
    targetProjection: '.agents/skills'
  })
  const applied = await harness.call('POST', '/takeover/apply', {
    previewId: preview.previewId,
    planHash: preview.planHash
  })
  const protectionPath = path.join(harness.root, 'data', 'product', 'protection', applied.protectionId, 'manifest.json')
  const protection = JSON.parse(fs.readFileSync(protectionPath, 'utf8'))
  assert.ok(Array.isArray(protection.createdDirectories))
  assert.ok(protection.createdDirectories.some((item) => item === '.agents'))
  assert.ok(protection.createdDirectories.some((item) => item === '.agents/skills'))
  assert.ok(protection.createdDirectories.some((item) => item.startsWith('.agents/skills/')))

  await harness.call('POST', '/takeover/rollback', { protectionId: applied.protectionId })
  assert.equal(fs.existsSync(path.join(targetRoot, '.agents')), false, 'rollback must remove the empty root created by takeover')
  assert.equal(fs.existsSync(path.join(targetRoot, 'skills')), false, 'rollback must not leave an alternate empty projection')
  assert.equal(fs.existsSync(path.join(targetRoot, 'canonical')), false, 'rollback must remove only transaction-created empty directories')
  assert.equal(fs.readdirSync(targetRoot).length, 0)
})

test('takeover rollback fails closed when an internal Junction was materialized', async (t) => {
  const harness = makeHarness(t)
  const { planId } = await initialize(harness)
  const targetRoot = path.join(harness.root, 'takeover-materialized-junction')
  const canonicalSkills = path.join(targetRoot, 'canonical', 'skills')
  const alias = path.join(targetRoot, '.agents', 'skills')
  fs.mkdirSync(canonicalSkills, { recursive: true })
  fs.mkdirSync(path.dirname(alias), { recursive: true })
  try {
    fs.symlinkSync(canonicalSkills, alias, 'junction')
  } catch {
    t.skip('Windows test host does not allow creating a Junction')
    return
  }

  const preview = await harness.call('POST', '/takeover/preview', {
    planId,
    worktreePath: targetRoot,
    targetProjection: '.agents/skills'
  })
  const applied = await harness.call('POST', '/takeover/apply', {
    previewId: preview.previewId,
    planHash: preview.planHash
  })
  const canonicalFile = path.join(canonicalSkills, 'demo', 'SKILL.md')
  assert.equal(fs.readFileSync(canonicalFile, 'utf8'), '# demo skill\n')

  try {
    fs.unlinkSync(alias)
  } catch {
    fs.rmdirSync(alias)
  }
  fs.mkdirSync(alias, { recursive: true })
  const privateMarker = path.join(alias, 'private-marker.txt')
  writeFile(privateMarker, 'must remain untouched\n')

  await assert.rejects(
    harness.call('POST', '/takeover/rollback', { protectionId: applied.protectionId }),
    (error) => error.code === 'PRODUCT_ROLLBACK_TOPOLOGY_CONFLICT'
  )
  assert.equal(fs.readFileSync(privateMarker, 'utf8'), 'must remain untouched\n')
  assert.equal(fs.readFileSync(canonicalFile, 'utf8'), '# demo skill\n', 'fail-closed rollback must not partially mutate the canonical target')
})

test('analysis fails closed on an external Junction and exposes safe recovery evidence', async (t) => {
  const harness = makeHarness(t)
  const outside = path.join(harness.root, 'outside-target')
  const link = path.join(harness.workspace, '.agents', 'skills', 'outside-skill')
  fs.mkdirSync(path.join(outside, 'outside-skill'), { recursive: true })
  writeFile(path.join(outside, 'outside-skill', 'SKILL.md'), '# must not be read\n')
  writeFile(path.join(outside, 'outside-skill', 'skills', 'nested', 'SKILL.md'), '# must not be discovered\n')
  try {
    fs.symlinkSync(path.join(outside, 'outside-skill'), link, 'junction')
  } catch {
    t.skip('Windows test host does not allow creating a Junction')
    return
  }
  const analysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  assert.equal(analysis.summary.externalLinks, 1)
  const blocked = analysis.systems.find((item) => item.kind === 'external-link')
  assert.ok(blocked)
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.selectable, false)
  assert.match(blocked.unavailableReason, /外部|停止读取/iu)
  assert.match(blocked.safeReason, /移入|规范目录/iu)
  assert.equal(blocked.files[0].stored, false)
  assert.equal(blocked.files[0].external, true)
  assert.ok(blocked.diagnosticPaths.length > 0)
  await assert.rejects(
    harness.call('POST', '/library/initialize', { analysisId: analysis.analysisId, selectedSystems: [blocked.id], acknowledgeProtection: true }),
    (error) => error.code === 'PRODUCT_EVIDENCE_NOT_SELECTABLE',
  )
})

test('nested external Junction traversal is counted once while distinct links remain distinct', async (t) => {
  const harness = makeHarness(t, { nested: true })
  const outside = path.join(harness.root, 'nested-outside-target')
  const link = path.join(harness.workspace, '.agents', 'skills')
  fs.rmSync(link, { recursive: true, force: true })
  writeFile(path.join(outside, 'unity-skills', 'demo', 'SKILL.md'), '# must not be read\n')
  try {
    fs.symlinkSync(outside, link, 'junction')
  } catch {
    t.skip('Windows test host does not allow creating a Junction')
    return
  }
  const analysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  assert.equal(analysis.summary.externalLinks, 1)
  const blocked = analysis.systems.find((item) => item.kind === 'external-link')
  assert.ok(blocked)
  assert.equal(blocked.files.length, 1)
  assert.equal(blocked.projections.length, 1)
  assert.equal(blocked.files[0].physicalPath, '.agents/skills')
  assert.equal(blocked.files[0].stored, false)
  assert.ok(!analysis.systems.flatMap((item) => item.files).some((file) => file.path.endsWith('unity-skills/demo/SKILL.md')))

  const distinct = makeHarness(t)
  const outsideA = path.join(distinct.root, 'outside-a')
  const outsideB = path.join(distinct.root, 'outside-b')
  writeFile(path.join(outsideA, 'SKILL.md'), '# a\n')
  writeFile(path.join(outsideB, 'SKILL.md'), '# b\n')
  try {
    fs.symlinkSync(outsideA, path.join(distinct.workspace, '.agents', 'skills', 'link-a'), 'junction')
    fs.symlinkSync(outsideB, path.join(distinct.workspace, '.agents', 'skills', 'link-b'), 'junction')
    fs.symlinkSync(outsideA, path.join(distinct.workspace, '.agents', 'skills', 'link-c'), 'junction')
  } catch {
    t.skip('Windows test host does not allow creating a Junction')
    return
  }
  const distinctAnalysis = await distinct.call('POST', '/analyze', { workspacePath: distinct.workspace })
  assert.equal(distinctAnalysis.summary.externalLinks, 3)
  const distinctBlocked = distinctAnalysis.systems.find((item) => item.kind === 'external-link')
  assert.ok(distinctBlocked)
  assert.equal(distinctBlocked.files.length, 3)
  assert.deepEqual(new Set(distinctBlocked.files.map((file) => file.physicalPath)), new Set(['.agents/skills/link-a', '.agents/skills/link-b', '.agents/skills/link-c']))
  const distinctChecked = await distinct.call('POST', '/workspace/check', { workspacePath: distinct.workspace })
  assert.equal(distinctChecked.summary.externalLinks, 3)
  assert.deepEqual(
    distinctChecked.systems.find((item) => item.kind === 'external-link').files.map((file) => file.physicalPath).sort(),
    ['.agents/skills/link-a', '.agents/skills/link-b', '.agents/skills/link-c']
  )
})

test('nested external Junction physical boundaries deduplicate alias and canonical projections', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-product-alias-canonical-'))
  const workspace = path.join(root, 'workspace')
  const canonicalSkills = path.join(workspace, 'baloot_client', '.agents', 'skills', 'unity-skills')
  const aliasSkills = path.join(workspace, '.agents', 'skills', 'unity-skills')
  const sameTarget = path.join(root, 'outside-same')
  const otherTarget = path.join(root, 'outside-other')
  writeFile(path.join(canonicalSkills, 'demo', 'SKILL.md'), '# canonical nested skill\n')
  fs.mkdirSync(path.dirname(aliasSkills), { recursive: true })
  fs.mkdirSync(sameTarget, { recursive: true })
  fs.mkdirSync(otherTarget, { recursive: true })
  const links = [
    ['same-a', sameTarget],
    ['same-b', sameTarget],
    ['other', otherTarget]
  ]
  try {
    fs.symlinkSync(canonicalSkills, aliasSkills, 'junction')
    for (const [name, target] of links) fs.symlinkSync(target, path.join(canonicalSkills, name), 'junction')
  } catch {
    t.skip('Windows test host does not allow creating a Junction')
    fs.rmSync(root, { recursive: true, force: true })
    return
  }
  const service = createProductService({ packageRoot: process.cwd(), dataRoot: path.join(root, 'data') })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const call = (method, pathname, body = {}, query = {}) => service.handle({
    method,
    pathname,
    body,
    searchParams: new URLSearchParams(query)
  })

  const analysis = await call('POST', '/analyze', { workspacePath: workspace })
  const blocked = analysis.systems.find((item) => item.kind === 'external-link')
  assert.ok(blocked)
  assert.equal(analysis.summary.externalLinks, 3)
  assert.equal(blocked.files.length, 3)
  assert.equal(new Set(blocked.files.map((file) => file.physicalPath)).size, 3)
  assert.equal(new Set(blocked.files.map((file) => file.canonicalTarget)).size, 2)
  assert.equal(blocked.files.filter((file) => file.canonicalTarget === fs.realpathSync(sameTarget)).length, 2)
  assert.equal(blocked.files.filter((file) => file.canonicalTarget === fs.realpathSync(otherTarget)).length, 1)

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'product', 'analyses', analysis.analysisId, 'manifest.json'), 'utf8'))
  const persistedBlocked = manifest.systems.find((item) => item.kind === 'external-link')
  assert.ok(persistedBlocked)
  assert.equal(new Set(persistedBlocked.files.map((file) => file.physicalBoundary)).size, 3)
})

test('nested internal Junction takeover persists selected scope and baseline across reanalysis', async (t) => {
  const harness = makeHarness(t, { nested: true })
  const { planId, system, skillPath } = await initialize(harness)
  assert.match(skillPath, /^skills\/unity-skills\//u)
  assert.ok(system.files.some((file) => file.path === 'skills/unity-skills/cache-control/SKILL.md'))
  assert.ok(system.files.some((file) => file.path === 'skills/unity-skills/backup-plans/SKILL.md'))
  const targetRoot = path.join(harness.root, 'takeover-nested')
  const canonicalSkills = path.join(targetRoot, 'canonical', 'unity-skills')
  const nestedLink = path.join(targetRoot, '.agents', 'skills', 'unity-skills')
  fs.mkdirSync(canonicalSkills, { recursive: true })
  fs.mkdirSync(path.dirname(nestedLink), { recursive: true })
  try {
    fs.symlinkSync(canonicalSkills, nestedLink, 'junction')
  } catch {
    t.skip('Windows test host does not allow creating a Junction')
    return
  }
  const exactJunctionTarget = fs.readlinkSync(nestedLink)

  const preview = await harness.call('POST', '/takeover/preview', {
    planId,
    worktreePath: targetRoot,
    targetProjection: '.agents/skills'
  })
  assert.equal(preview.available, true)
  assert.equal(preview.targetProjection, '.agents/skills')
  assert.ok(preview.targetOptions.some((option) => option.value === '.agents/skills' && option.available === true))
  const nestedOperation = preview.operations.find((operation) => operation.path === skillPath)
  assert.ok(nestedOperation)
  assert.ok(nestedOperation.targetPath.startsWith('canonical/unity-skills/'))
  assert.equal(nestedOperation.canonicalTarget, path.resolve(canonicalSkills))
  assert.equal(preview.canonicalTarget, path.resolve(canonicalSkills))
  assert.equal(preview.canonicalTargetDirectory, path.resolve(canonicalSkills))
  assert.equal(preview.targetOptions.find((option) => option.value === '.agents/skills').canonicalTargetDirectory, path.resolve(canonicalSkills))
  assert.ok(preview.operations.every((operation) => operation.canonicalTarget === path.resolve(canonicalSkills)))
  assert.equal(fs.statSync(preview.canonicalTarget).isDirectory(), true)

  // A content-file target must be rejected even when it sits below the
  // otherwise valid internal Junction destination.
  writeFile(path.join(canonicalSkills, 'references', '2d.md'), '# content file\n')
  await assert.rejects(
    harness.call('POST', '/takeover/apply', {
      previewId: preview.previewId,
      planHash: preview.planHash,
      canonicalTarget: path.join(canonicalSkills, 'references', '2d.md')
    }),
    (error) => error.code === 'PRODUCT_TAKEOVER_UNSUPPORTED',
  )

  const applied = await harness.call('POST', '/takeover/apply', {
    previewId: preview.previewId,
    planHash: preview.planHash,
    targetProjection: preview.targetProjection,
    canonicalTarget: preview.canonicalTarget,
    selectedSystemIds: preview.selectedSystemIds,
    selectedSystemRefs: preview.selectedSystemRefs
  })
  assert.equal(applied.status, 'applied')
  assert.equal(applied.canonicalTarget, path.resolve(canonicalSkills))
  assert.equal(applied.canonicalTargetDirectory, path.resolve(canonicalSkills))
  assert.deepEqual(applied.selectedSystemIds, [system.id])
  assert.ok(applied.baselineVersion)
  assert.match(applied.baselineSignature, /^[a-f0-9]{64}$/u)
  assert.equal(fs.readFileSync(path.join(canonicalSkills, 'demo', 'SKILL.md'), 'utf8'), '# nested demo skill\n')
  assert.equal(fs.lstatSync(nestedLink).isSymbolicLink(), true)
  const protection = JSON.parse(fs.readFileSync(path.join(harness.root, 'data', 'product', 'protection', applied.protectionId, 'manifest.json'), 'utf8'))
  assert.equal(protection.canonicalTarget, path.resolve(canonicalSkills))
  assert.equal(protection.canonicalTargetDirectory, path.resolve(canonicalSkills))
  assert.ok(protection.linkTopology.some((entry) => entry.path === '.agents/skills/unity-skills' && entry.type === 'junction' && entry.target === exactJunctionTarget))

  writeFile(path.join(targetRoot, '.cursor', 'skills', 'unrelated', 'SKILL.md'), '# unrelated scope\n')
  const reanalysis = await harness.call('POST', '/analyze', { workspacePath: targetRoot })
  assert.deepEqual(reanalysis.workspace.selectedSystemIds, [system.id])
  assert.ok(reanalysis.workspace.selectedSystemRefs.some((ref) => ref.id === system.id))
  assert.equal(reanalysis.workspace.baselineVersion, applied.baselineVersion)
  assert.equal(reanalysis.workspace.baselineSignature, applied.baselineSignature)
  const widened = await harness.call('POST', '/compare', {
    planId,
    analysisId: reanalysis.analysisId,
    workspacePath: targetRoot,
    selectedSystems: reanalysis.systems.filter((item) => item.selectable).map((item) => item.id)
  })
  assert.deepEqual(widened.selectedSystems.map((item) => item.id), [system.id], 'connected compare must reuse the persisted one-system scope')

  await harness.call('POST', '/takeover/rollback', { protectionId: applied.protectionId })
  assert.equal(fs.existsSync(path.join(canonicalSkills, 'demo', 'SKILL.md')), false)
  assert.equal(fs.lstatSync(nestedLink).isSymbolicLink(), true, 'rollback must preserve the alias as a reparse point')
  assert.equal(fs.readlinkSync(nestedLink), exactJunctionTarget, 'rollback must preserve the exact Junction target')

  const state = JSON.parse(fs.readFileSync(path.join(harness.root, 'data', 'product', 'state.json'), 'utf8'))
  assert.equal(state.analyses[protection.postApplyAnalysisId]?.lifecycle, 'takeover-rolled-back-history')
  assert.equal(state.analyses[protection.postApplyAnalysisId]?.protectionId, applied.protectionId)
  const analysisRoot = path.join(harness.root, 'data', 'product', 'analyses')
  const diskAnalysisIds = fs.readdirSync(analysisRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  assert.deepEqual(diskAnalysisIds, Object.keys(state.analyses).sort(), 'apply and rollback must not leave an unindexed analysis directory')
})

test('three-way comparison omits converged identical content and drafts only real workspace changes', async (t) => {
  const harness = makeHarness(t)
  const { planId, system, skillPath } = await initialize(harness)

  const centerDraft = await harness.call('POST', '/library/draft', { planId, action: 'edit', path: skillPath })
  const convergedContent = '# center and workspace already agree\n'
  await harness.call('POST', '/draft/file', { draftId: centerDraft.draftId, path: skillPath, content: convergedContent })
  await harness.call('POST', '/draft/confirm', { draftId: centerDraft.draftId, path: skillPath, confirmed: true })
  await harness.call('POST', '/draft/commit', { draftId: centerDraft.draftId, message: 'center v2' })
  writeFile(path.join(harness.workspace, '.agents', 'skills', 'demo', 'SKILL.md'), convergedContent)
  writeFile(path.join(harness.workspace, '.agents', 'skills', 'real-added-a', 'SKILL.md'), '# real a\n')
  writeFile(path.join(harness.workspace, '.agents', 'skills', 'real-added-b', 'SKILL.md'), '# real b\n')

  const analysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace, mode: 'merge' })
  const comparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: analysis.analysisId,
    workspacePath: harness.workspace,
    mode: 'merge',
    selectedSystems: [system.id],
  })
  assert.ok(!comparison.files.some((file) => file.path === skillPath), 'identical converged content is not a change')
  assert.equal(comparison.summary.workspaceChanged, 2)
  assert.deepEqual(comparison.files.map((file) => file.path).sort(), [
    'skills/real-added-a/SKILL.md',
    'skills/real-added-b/SKILL.md',
  ])
  const draft = await harness.call('POST', '/library/draft', {
    comparisonId: comparison.comparisonId,
    planId,
    paths: comparison.files.map((file) => file.path),
    origin: 'workspace-review',
  })
  assert.deepEqual(draft.files.map((file) => file.path).sort(), comparison.files.map((file) => file.path).sort())
})

test('merged commit persists an authoritative receipt and all public counts come from the current manifest', async (t) => {
  const harness = makeHarness(t)
  const { planId, system } = await initialize(harness)
  writeFile(path.join(harness.workspace, '.agents', 'skills', 'manifest-count-added', 'SKILL.md'), '# added\n')
  const analysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace, mode: 'merge' })
  const comparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: analysis.analysisId,
    workspacePath: harness.workspace,
    mode: 'merge',
    selectedSystems: [system.id],
  })
  const draft = await harness.call('POST', '/library/draft', {
    comparisonId: comparison.comparisonId,
    planId,
    paths: comparison.files.map((file) => file.path),
    origin: 'workspace-review',
  })
  for (const file of draft.files) {
    await harness.call('POST', '/draft/confirm', { draftId: draft.draftId, path: file.path, confirmed: true })
  }
  const committed = await harness.call('POST', '/draft/commit', { draftId: draft.draftId, message: 'merged count change' })
  const overview = await harness.call('GET', '/overview')
  const library = await harness.call('GET', '/library')
  const currentSkillCount = committed.version.files.filter((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path)).length
  assert.deepEqual(overview.mergeReceipt, {
    status: 'merged',
    planId,
    versionId: committed.version.versionId,
    workspacePath: path.resolve(harness.workspace),
    draftId: draft.draftId,
    fileCount: draft.files.length,
    createdAt: committed.version.createdAt,
  })
  assert.equal(overview.plans[0].skillCount, currentSkillCount)
  assert.equal(overview.plans[0].fileCount, committed.version.files.length)
  assert.equal(library.plan.skillCount, currentSkillCount)
  assert.equal(library.plan.fileCount, committed.version.files.length)
  assert.equal(library.systems[0].skillCount, currentSkillCount, 'library project card must use the current manifest count')
  assert.equal(library.systems[0].fileCount, committed.version.files.length)
  assert.equal(committed.commitReceipt.status, 'committed')
  assert.equal(committed.commitReceipt.origin, 'workspace-review')
  assert.deepEqual(committed.mergeReceipt, overview.mergeReceipt)
  assert.deepEqual(overview.commitReceipt, committed.commitReceipt)
  const versionDir = path.join(harness.root, 'data', 'product', 'library', planId, 'versions', committed.version.versionId)
  const persistedManifest = JSON.parse(fs.readFileSync(path.join(versionDir, 'manifest.json'), 'utf8'))
  const persistedCommitReceipt = JSON.parse(fs.readFileSync(path.join(versionDir, 'commit-receipt.json'), 'utf8'))
  const persistedMergeReceipt = JSON.parse(fs.readFileSync(path.join(versionDir, 'merge-receipt.json'), 'utf8'))
  assert.deepEqual(persistedManifest.commitReceipt, committed.commitReceipt)
  assert.deepEqual(persistedManifest.mergeReceipt, committed.mergeReceipt)
  assert.deepEqual(persistedCommitReceipt, committed.commitReceipt)
  assert.deepEqual(persistedMergeReceipt, committed.mergeReceipt)
  const historicalOverview = await harness.call('GET', '/overview', {}, { versionId: committed.version.versionId })
  assert.deepEqual(historicalOverview.commitReceipt, committed.commitReceipt, 'version URL must recover the immutable commit receipt')
  assert.deepEqual(historicalOverview.mergeReceipt, committed.mergeReceipt, 'version URL must recover the immutable merge receipt')
  const historicalLibrary = await harness.call('GET', '/library', {}, { versionId: committed.version.versionId })
  assert.deepEqual(historicalLibrary.mergeReceipt, committed.mergeReceipt)
  const historicalFile = await harness.call('GET', '/library/file', {}, { planId, versionId: committed.version.versionId, path: 'skills/manifest-count-added/SKILL.md' })
  assert.deepEqual(historicalFile.mergeReceipt, committed.mergeReceipt)
  const resumed = createProductService({ packageRoot: process.cwd(), dataRoot: path.join(harness.root, 'data') })
  const resumedOverview = await resumed.handle({
    method: 'GET',
    pathname: '/overview',
    body: {},
    searchParams: new URLSearchParams({ versionId: committed.version.versionId })
  })
  assert.deepEqual(resumedOverview.mergeReceipt, committed.mergeReceipt)
  const comparisonRead = await harness.call('GET', '/comparison', {}, { comparisonId: comparison.comparisonId })
  assert.deepEqual(comparisonRead.commitReceipt, committed.commitReceipt)
  assert.deepEqual(comparisonRead.mergeReceipt, committed.mergeReceipt)
  const rollbackPreview = await harness.call('POST', '/version/rollback/preview', { planId, versionId: 'v1' })
  const rolledBack = await harness.call('POST', '/version/rollback', {
    previewId: rollbackPreview.previewId,
    planHash: rollbackPreview.planHash,
    confirm: true
  })
  assert.equal(rolledBack.version.commitReceipt, undefined)
  assert.equal(rolledBack.version.mergeReceipt, undefined)
  const rollbackManifest = JSON.parse(fs.readFileSync(path.join(harness.root, 'data', 'product', 'library', planId, 'versions', rolledBack.version.versionId, 'manifest.json'), 'utf8'))
  assert.equal(rollbackManifest.commitReceipt, undefined)
  assert.equal(rollbackManifest.mergeReceipt, undefined)
})

test('manual and center-only commits persist immutable receipts without a merge receipt', async (t) => {
  const harness = makeHarness(t)
  const { planId, skillPath } = await initialize(harness)
  const draft = await harness.call('POST', '/library/draft', { planId, action: 'edit', path: skillPath })
  await harness.call('POST', '/draft/file', { draftId: draft.draftId, path: skillPath, content: '# center-only durable receipt\n' })
  await harness.call('POST', '/draft/confirm', { draftId: draft.draftId, path: skillPath, confirmed: true })
  const committed = await harness.call('POST', '/draft/commit', { draftId: draft.draftId, message: '中心库单边保存回执' })
  const receipt = committed.commitReceipt
  assert.equal(receipt.status, 'committed')
  assert.equal(receipt.planId, planId)
  assert.equal(receipt.versionId, 'v2')
  assert.equal(receipt.draftId, draft.draftId)
  assert.equal(receipt.origin, 'library-manual-edit')
  assert.equal(committed.draft.commitReceipt.versionId, 'v2')

  const receiptPath = path.join(harness.root, 'data', 'product', 'library', planId, 'versions', 'v2', 'commit-receipt.json')
  const receiptBytesBefore = fs.readFileSync(receiptPath)
  const stateBefore = JSON.parse(fs.readFileSync(path.join(harness.root, 'data', 'product', 'state.json'), 'utf8'))
  assert.equal(stateBefore.mergeReceipt, null, 'center-only commits must not look like workspace merges')
  assert.ok(Object.values(stateBefore.commitReceipts).some((item) => item.draftId === draft.draftId && item.versionId === 'v2'))

  const overview = await harness.call('GET', '/overview')
  assert.deepEqual(overview.commitReceipt, receipt)
  assert.equal(overview.mergeReceipt, null)
  const library = await harness.call('GET', '/library')
  assert.deepEqual(library.commitReceipt, receipt)
  const readDraft = await harness.call('GET', '/draft', {}, { draftId: draft.draftId })
  assert.deepEqual(readDraft.commitReceipt, receipt)
  const byVersion = await harness.call('GET', '/overview', {}, { versionId: 'v2' })
  assert.deepEqual(byVersion.commitReceipt, receipt)
  const centerManifest = JSON.parse(fs.readFileSync(path.join(harness.root, 'data', 'product', 'library', planId, 'versions', 'v2', 'manifest.json'), 'utf8'))
  assert.deepEqual(centerManifest.commitReceipt, receipt)
  assert.equal(centerManifest.mergeReceipt, null, 'center-only versions must persist no merge receipt')
  assert.equal(fs.existsSync(path.join(harness.root, 'data', 'product', 'library', planId, 'versions', 'v2', 'merge-receipt.json')), false)
  const byFile = await harness.call('GET', '/library/file', {}, { planId, versionId: 'v2', path: skillPath })
  assert.deepEqual(byFile.commitReceipt, receipt)
  assert.equal(byFile.mergeReceipt, null)

  // A pending workspace comparison is independent UI state and must not hide
  // or replace the receipt for the already committed center-library version.
  writeFile(path.join(harness.workspace, '.agents', 'skills', 'receipt-pending', 'SKILL.md'), '# pending workspace change\n')
  const pendingAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  await harness.call('POST', '/compare', {
    planId,
    analysisId: pendingAnalysis.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [
      (await harness.call('GET', '/overview')).workspaces.find((item) => item.workspacePath === path.resolve(harness.workspace)).selectedSystemIds[0]
    ]
  })
  assert.deepEqual((await harness.call('GET', '/overview')).commitReceipt, receipt)
  assert.deepEqual((await harness.call('GET', '/library')).commitReceipt, receipt)
  assert.equal(Buffer.compare(receiptBytesBefore, fs.readFileSync(receiptPath)), 0, 'immutable receipt bytes must not change after refresh/pending comparison')

  const resumed = createProductService({ packageRoot: process.cwd(), dataRoot: path.join(harness.root, 'data') })
  const resumedOverview = await resumed.handle({ method: 'GET', pathname: '/overview', body: {}, searchParams: new URLSearchParams() })
  assert.deepEqual(resumedOverview.commitReceipt, receipt, 'a new service instance must recover the receipt')
  const resumedDraft = await resumed.handle({ method: 'GET', pathname: '/draft', body: {}, searchParams: new URLSearchParams({ draftId: draft.draftId }) })
  assert.deepEqual(resumedDraft.commitReceipt, receipt)
})

test('full reconnect restores one durable system scope across a new analysis and never expands on ambiguity', async (t) => {
  const harness = makeHarness(t)
  const { planId, system } = await initialize(harness)
  const originalId = system.id
  writeFile(path.join(harness.workspace, 'other-project', '.agents', 'skills', 'new-system', 'SKILL.md'), '# another system\n')

  const reconnect = await harness.call('POST', '/analyze', {
    workspacePath: harness.workspace,
    mode: 'connect',
    purpose: 'connect'
  })
  assert.deepEqual(reconnect.workspace.selectedSystemIds, [originalId])
  assert.equal(reconnect.workspace.selectedSystemRefs.length, 1)
  assert.equal(reconnect.workspace.selectionNeedsReview, false)
  const discoveredIds = reconnect.systems.filter((item) => item.selectable).map((item) => item.id)
  assert.ok(discoveredIds.includes(originalId))
  assert.ok(discoveredIds.some((id) => id !== originalId), 'the new analysis should expose a second candidate')

  const compareWithStaleBrowserScope = await harness.call('POST', '/compare', {
    planId,
    analysisId: reconnect.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: discoveredIds
  })
  assert.deepEqual(compareWithStaleBrowserScope.selectedSystems.map((item) => item.id), [originalId])

  fs.rmSync(path.join(harness.workspace, '.agents'), { recursive: true, force: true })
  writeFile(path.join(harness.workspace, 'scope-a', '.agents', 'skills', 'demo', 'SKILL.md'), '# demo skill\n')
  writeFile(path.join(harness.workspace, 'scope-b', '.agents', 'skills', 'demo', 'SKILL.md'), '# demo skill\n')
  const ambiguous = await harness.call('POST', '/analyze', {
    workspacePath: harness.workspace,
    mode: 'connect',
    purpose: 'connect'
  })
  assert.equal(ambiguous.workspace.selectionNeedsReview, true)
  assert.deepEqual(ambiguous.workspace.selectedSystemIds, [])
  assert.ok(ambiguous.workspace.unresolvedSelectedSystemRefs.length > 0)
  assert.ok(ambiguous.systems.filter((item) => item.selectable).every((item) => !ambiguous.workspace.selectedSystemIds.includes(item.id)))
  await assert.rejects(
    harness.call('POST', '/workspace/complete-connection', {
      planId,
      analysisId: ambiguous.analysisId,
      workspacePath: harness.workspace,
      selectedSystems: [ambiguous.systems.find((item) => item.selectable).id]
    }),
    (error) => error.code === 'PRODUCT_SYSTEM_SELECTION_REQUIRED',
  )
  await assert.rejects(
    harness.call('POST', '/compare', {
      planId,
      analysisId: ambiguous.analysisId,
      workspacePath: harness.workspace,
      selectedSystems: ambiguous.systems.filter((item) => item.selectable).map((item) => item.id)
    }),
    (error) => error.code === 'PRODUCT_SYSTEM_SELECTION_REQUIRED',
  )
})

test('full reconnect reuses durable scope and treats center-only library additions as a no-op', async (t) => {
  const harness = makeHarness(t)
  const { planId, system } = await initialize(harness)
  const centerOnlyPath = 'skills/center-only/SKILL.md'
  const centerDraft = await harness.call('POST', '/library/draft', {
    planId,
    action: 'create',
    path: centerOnlyPath,
    content: '# center-only library skill\n'
  })
  await harness.call('POST', '/draft/confirm', { draftId: centerDraft.draftId, path: centerOnlyPath, confirmed: true })
  const committed = await harness.call('POST', '/draft/commit', { draftId: centerDraft.draftId, message: '中心库单边新增' })
  assert.equal(committed.version.versionId, 'v2')

  const reconnect = await harness.call('POST', '/analyze', {
    workspacePath: harness.workspace,
    mode: 'connect',
    purpose: 'connect'
  })
  assert.deepEqual(reconnect.workspace.selectedSystemIds, [system.id])
  assert.equal(reconnect.workspace.selectedSystemRefs.length, 1)
  const staleBrowserIds = reconnect.systems.filter((item) => item.selectable).map((item) => item.id)
  const comparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: reconnect.analysisId,
    workspacePath: harness.workspace,
    mode: 'merge',
    selectedSystems: staleBrowserIds
  })
  assert.deepEqual(comparison.selectedSystemIds, [system.id])
  assert.equal(comparison.summary.workspaceChanged, 0)
  assert.equal(comparison.summary.noOp, true)
  assert.equal(comparison.summary.deleted, 0)
  const centerOnly = comparison.files.find((file) => file.path === centerOnlyPath)
  assert.ok(centerOnly)
  assert.equal(centerOnly.direction, 'center-only')
  assert.notEqual(centerOnly.changeType, 'deleted')

  const completed = await harness.call('POST', '/workspace/complete-connection', {
    planId,
    analysisId: reconnect.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: staleBrowserIds
  })
  assert.equal(completed.status, 'connected-noop')
  assert.equal(completed.version.created, false)
  assert.equal(completed.createdVersion, null)
  assert.deepEqual(completed.workspace.selectedSystemIds, [system.id])
  assert.equal((await harness.call('GET', '/library')).plan.currentVersion, 'v2')
})

test('center-only lifecycle stays outside an older workspace baseline and completes reconnect as a current-version no-op', async (t) => {
  const harness = makeHarness(t)
  const { planId, system } = await initialize(harness)
  const centerOnlyPaths = ['skills/center-only/SKILL.md', 'rules/center-only.md']

  for (const centerOnlyPath of centerOnlyPaths) {
    const created = await harness.call('POST', '/library/draft', {
      planId,
      action: 'create',
      path: centerOnlyPath,
      content: `# ${centerOnlyPath}\nline two\n`
    })
    await harness.call('POST', '/draft/confirm', { draftId: created.draftId, path: centerOnlyPath, confirmed: true })
    await harness.call('POST', '/draft/commit', { draftId: created.draftId, message: `创建 ${centerOnlyPath}` })
  }
  assert.equal((await harness.call('GET', '/library')).plan.currentVersion, 'v3')

  // Move the connection baseline forward while the workspace remains
  // unchanged. The two files are in the center manifest, but not in the
  // selected workspace system's durable path set.
  const baselineAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace, mode: 'connect', purpose: 'connect' })
  const connected = await harness.call('POST', '/workspace/complete-connection', {
    planId,
    analysisId: baselineAnalysis.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [system.id]
  })
  assert.equal(connected.version.versionId, 'v3')
  assert.equal(connected.workspace.baselineVersion, 'v3')

  const unchangedAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace, mode: 'connect', purpose: 'connect' })
  const unchanged = await harness.call('POST', '/compare', {
    planId,
    analysisId: unchangedAnalysis.analysisId,
    workspacePath: harness.workspace,
    mode: 'merge',
    selectedSystems: [system.id]
  })
  assert.equal(unchanged.summary.workspaceChanged, 0)
  assert.equal(unchanged.summary.noOp, true)
  assert.equal(unchanged.summary.conflicts, 0)
  assert.ok(unchanged.files.every((file) => !centerOnlyPaths.includes(file.path) || file.direction === 'center-only'))
  assert.ok(!unchanged.files.some((file) => file.direction === 'workspace-only' || file.direction === 'conflict'))

  // Delete the center-only lifecycle from the current center version. The
  // selected workspace baseline is intentionally still v3 and must not turn
  // the old center records into +0/-0 conflicts.
  for (const centerOnlyPath of centerOnlyPaths) {
    const deleted = await harness.call('POST', '/library/draft', { planId, action: 'delete', path: centerOnlyPath })
    await harness.call('POST', '/draft/confirm', { draftId: deleted.draftId, path: centerOnlyPath, confirmed: true })
    await harness.call('POST', '/draft/commit', { draftId: deleted.draftId, message: `删除 ${centerOnlyPath}` })
  }
  const beforeReconnect = await harness.call('GET', '/overview')
  const beforeWorkspace = beforeReconnect.workspaces.find((item) => item.workspacePath === harness.workspace)
  assert.equal(beforeWorkspace.baselineVersion, 'v3')
  assert.equal((await harness.call('GET', '/library')).plan.currentVersion, 'v5')

  const deletedAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace, mode: 'connect', purpose: 'connect' })
  const deletedComparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: deletedAnalysis.analysisId,
    workspacePath: harness.workspace,
    mode: 'merge',
    selectedSystems: [system.id]
  })
  assert.equal(deletedComparison.summary.workspaceChanged, 0)
  assert.equal(deletedComparison.summary.noOp, true)
  assert.equal(deletedComparison.summary.conflicts, 0)
  assert.ok(!deletedComparison.files.some((file) => centerOnlyPaths.includes(file.path)), 'center-only records absent from both current sides must not become fake conflicts')

  const completed = await harness.call('POST', '/workspace/complete-connection', {
    planId,
    analysisId: deletedAnalysis.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [system.id]
  })
  assert.equal(completed.status, 'connected-noop')
  assert.equal(completed.createdVersion, null)
  assert.equal(completed.version.versionId, 'v5')
  assert.equal(completed.version.created, false)
  assert.equal(completed.workspace.baselineVersion, 'v5')
  assert.equal((await harness.call('GET', '/library')).plan.currentVersion, 'v5')
})

test('quick connected reanalysis carries external-link evidence and cannot report a silent no-change result', async (t) => {
  const harness = makeHarness(t)
  const { planId } = await initialize(harness)
  const outside = path.join(harness.root, 'quick-outside')
  const link = path.join(harness.workspace, '.agents', 'skills', 'quick-outside')
  writeFile(path.join(outside, 'SKILL.md'), '# must not be read\n')
  try {
    fs.symlinkSync(outside, link, 'junction')
  } catch {
    t.skip('Windows test host does not allow creating a Junction')
    return
  }

  const checked = await harness.call('POST', '/workspace/check', {
    workspacePath: harness.workspace,
    worktreePath: harness.workspace
  })
  assert.equal(checked.safety.blocked, true)
  assert.ok(checked.safety.blockedSystems.length > 0)
  assert.ok(checked.safety.blockedSystems[0].diagnosticPaths.length > 0)
  assert.match(checked.safety.blockedSystems[0].safeReason, /移入|规范目录/iu)
  assert.equal(checked.workspace.safetyBlocked, true)
  assert.equal(checked.workspace.status, 'connected-safety-blocked')
  assert.equal(checked.changes.detected, true)
  assert.notEqual(checked.changes.detected, false)
  await assert.rejects(
    harness.call('POST', '/compare', {
      planId,
      analysisId: checked.analysisId,
      workspacePath: harness.workspace,
      selectedSystems: checked.workspace.selectedSystemIds
    }),
    (error) => error.code === 'PRODUCT_EXTERNAL_LINK' && /外部|停止读取/iu.test(error.message),
  )
})

test('zero-diff check, compare, and completion clear all pending state while preserving the connection baseline', async (t) => {
  const harness = makeHarness(t)
  const { planId, system, initialized } = await initialize(harness)
  const baseline = {
    selectedSystemIds: initialized.workspace.selectedSystemIds,
    selectedSystemRefs: initialized.workspace.selectedSystemRefs,
    baselineVersion: initialized.workspace.baselineVersion,
    baselineSignature: initialized.workspace.baselineSignature,
  }
  const transientPath = path.join(harness.workspace, '.agents', 'skills', 'transient-zero-diff', 'SKILL.md')
  writeFile(transientPath, '# transient change\n')
  const changedAnalysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const changedComparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: changedAnalysis.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [system.id]
  })
  assert.equal(changedComparison.summary.workspaceChanged, 1)
  const pending = (await harness.call('GET', '/overview')).workspaces.find((item) => item.workspacePath === path.resolve(harness.workspace))
  assert.equal(pending.hasUpdates, true)
  assert.ok(pending.pendingAnalysisId)
  assert.ok(pending.pendingComparisonId)
  assert.ok(pending.pendingSummary)

  fs.rmSync(transientPath)
  const checked = await harness.call('POST', '/workspace/check', { workspacePath: harness.workspace })
  assert.equal(checked.workspace.hasUpdates, false)
  assert.equal(checked.workspace.pendingAnalysisId, null)
  assert.equal(checked.workspace.pendingComparisonId, null)
  assert.equal(checked.workspace.pendingSummary, null)
  assert.deepEqual(checked.workspace.selectedSystemIds, baseline.selectedSystemIds)
  assert.deepEqual(checked.workspace.selectedSystemRefs.map((ref) => ref.id), baseline.selectedSystemRefs.map((ref) => ref.id))
  assert.equal(checked.workspace.baselineVersion, baseline.baselineVersion)
  assert.equal(checked.workspace.baselineSignature, baseline.baselineSignature)

  const compared = await harness.call('POST', '/compare', {
    planId,
    analysisId: checked.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [system.id]
  })
  assert.equal(compared.summary.workspaceChanged, 0)
  const afterCompare = (await harness.call('GET', '/overview')).workspaces.find((item) => item.workspacePath === path.resolve(harness.workspace))
  assert.equal(afterCompare.hasUpdates, false)
  assert.equal(afterCompare.pendingAnalysisId, null)
  assert.equal(afterCompare.pendingComparisonId, null)
  assert.equal(afterCompare.pendingSummary, null)
  assert.deepEqual(afterCompare.selectedSystemIds, baseline.selectedSystemIds)
  assert.equal(afterCompare.baselineVersion, baseline.baselineVersion)
  assert.equal(afterCompare.baselineSignature, baseline.baselineSignature)

  const completed = await harness.call('POST', '/workspace/complete-connection', {
    planId,
    analysisId: checked.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [system.id]
  })
  assert.equal(completed.status, 'connected-noop')
  assert.equal(completed.createdVersion, null)
  assert.equal(completed.version.created, false)
  assert.equal(completed.workspace.hasUpdates, false)
  assert.equal(completed.workspace.pendingAnalysisId, null)
  assert.equal(completed.workspace.pendingComparisonId, null)
  assert.equal(completed.workspace.pendingSummary, null)
  assert.deepEqual(completed.workspace.selectedSystemIds, baseline.selectedSystemIds)
  assert.equal(completed.workspace.baselineVersion, baseline.baselineVersion)
  assert.equal(completed.workspace.baselineSignature, baseline.baselineSignature)
  assert.equal((await harness.call('GET', '/library')).plan.currentVersion, 'v1')
})

test('takeover rollback restores the pre-takeover connection snapshot and zero-diff reconnect is a no-op', async (t) => {
  const harness = makeHarness(t)
  const { planId, system, initialized } = await initialize(harness)
  const before = initialized.workspace
  const preview = await harness.call('POST', '/takeover/preview', {
    planId,
    worktreePath: harness.workspace,
    targetProjection: '.agents/skills'
  })
  const applied = await harness.call('POST', '/takeover/apply', {
    previewId: preview.previewId,
    planHash: preview.planHash,
    targetProjection: preview.targetProjection,
    canonicalTarget: preview.canonicalTarget,
    selectedSystemIds: preview.selectedSystemIds,
    selectedSystemRefs: preview.selectedSystemRefs
  })
  assert.equal(applied.workspace.connectionMode, 'takeover')
  const rolledBack = await harness.call('POST', '/takeover/rollback', { protectionId: applied.protectionId })
  assert.equal(rolledBack.workspace.status, 'connected')
  assert.equal(rolledBack.workspace.connectionMode, before.connectionMode)
  assert.deepEqual(rolledBack.workspace.selectedSystemIds, before.selectedSystemIds)
  assert.equal(rolledBack.workspace.baselineVersion, before.baselineVersion)
  assert.equal(rolledBack.workspace.baselineSignature, before.baselineSignature)
  assert.equal(rolledBack.workspace.connectionRecoveryRequired, false)
  const duplicateRollback = await harness.call('POST', '/takeover/rollback', { protectionId: applied.protectionId })
  assert.equal(duplicateRollback.status, 'rolled-back')
  assert.equal(duplicateRollback.idempotent, true)
  assert.equal(duplicateRollback.workspace.connectionMode, before.connectionMode)

  const analysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const comparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: analysis.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [system.id]
  })
  assert.equal(comparison.summary.workspaceChanged, 0)
  const connected = await harness.call('POST', '/workspace/complete-connection', {
    planId,
    analysisId: analysis.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [system.id]
  })
  assert.equal(connected.status, 'connected-noop')
  assert.equal(connected.createdVersion, null)
  assert.equal(connected.version.created, false)
  assert.equal((await harness.call('GET', '/library')).plan.currentVersion, 'v1')
})

test('connected workspace deletion is discovered, staged as a tombstone, confirmed, and saved as a new version', async (t) => {
  const harness = makeHarness(t)
  const { planId, system, skillPath } = await initialize(harness)
  fs.rmSync(path.join(harness.workspace, '.agents', 'skills', 'demo', 'SKILL.md'))
  const analysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const comparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: analysis.analysisId,
    workspacePath: harness.workspace,
    selectedSystems: [system.id]
  })
  const deletion = comparison.files.find((file) => file.path === skillPath)
  assert.ok(deletion)
  assert.equal(deletion.changeType, 'deleted')
  assert.equal(deletion.direction, 'workspace-only')
  assert.equal(comparison.summary.deleted, 1)
  assert.equal(comparison.summary.workspaceChanged, 1)

  const draft = await harness.call('POST', '/library/draft', {
    comparisonId: comparison.comparisonId,
    planId,
    paths: [skillPath],
    origin: 'workspace-review'
  })
  const staged = draft.files.find((file) => file.path === skillPath)
  assert.ok(staged)
  assert.equal(staged.deleted, true)
  assert.match(staged.originalContent, /demo skill/iu)
  await harness.call('POST', '/draft/confirm', { draftId: draft.draftId, path: skillPath, confirmed: true })
  const committed = await harness.call('POST', '/draft/commit', { draftId: draft.draftId, message: '确认删除工作区已删除文件' })
  assert.equal(committed.version.versionId, 'v2')
  assert.ok(committed.version.files.every((file) => file.path !== skillPath))
  const v1 = await harness.call('GET', '/library/file', {}, { planId, version: 'v1', path: skillPath })
  assert.match(v1.content, /demo skill/iu)
  await assert.rejects(
    harness.call('GET', '/library/file', {}, { planId, version: 'v2', path: skillPath }),
    (error) => error.code === 'PRODUCT_NOT_FOUND',
  )
})

test('deleted tombstone reaches manual review when AI returns no file body, then creates the next version', async (t) => {
  let sessionState = 'running'
  const executeTyped = async (command) => {
    if (command.kind === 'chat') return { session: { id: 'ai-delete', status: 'running', capabilities: { canCancel: true } } }
    if (command.kind === 'getSession') return { session: { id: command.sessionId, status: sessionState, lastMessage: 'AI 没有生成文件正文' } }
    throw new Error(`unexpected command ${command.kind}`)
  }
  const harness = makeHarness(t, { executeTyped })
  const { planId, system, skillPath } = await initialize(harness)
  fs.rmSync(path.join(harness.workspace, '.agents', 'skills', 'demo', 'SKILL.md'))
  const analysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const comparison = await harness.call('POST', '/compare', { planId, analysisId: analysis.analysisId, workspacePath: harness.workspace, selectedSystems: [system.id] })
  const draft = await harness.call('POST', '/library/draft', { comparisonId: comparison.comparisonId, planId, paths: [skillPath], origin: 'workspace-review' })
  const running = await harness.call('POST', '/draft/ai', { draftId: draft.draftId, message: '请整理结果', selectedFiles: [skillPath] })
  sessionState = 'completed'
  const status = await harness.call('GET', '/chat/status', {}, { sessionId: running.chatId })
  assert.equal(status.synchronizedDraft, true)
  const reviewed = await harness.call('GET', '/draft', {}, { draftId: draft.draftId })
  assert.equal(reviewed.files[0].deleted, true)
  assert.equal(reviewed.files[0].aiSkipped, true)
  assert.match(reviewed.files[0].aiReviewNote, /人工确认/iu)
  await harness.call('POST', '/draft/confirm', { draftId: draft.draftId, path: skillPath, confirmed: true })
  const committed = await harness.call('POST', '/draft/commit', { draftId: draft.draftId, message: '人工确认删除' })
  assert.equal(committed.version.versionId, 'v2')
})

test('rollback requires a persisted preview, exposes scope and diff, then appends one confirmed version', async (t) => {
  const harness = makeHarness(t)
  const { planId, skillPath } = await initialize(harness)
  const draft = await harness.call('POST', '/library/draft', { planId, action: 'edit', path: skillPath })
  await harness.call('POST', '/draft/file', { draftId: draft.draftId, path: skillPath, content: '# v2 center change\n' })
  await harness.call('POST', '/draft/confirm', { draftId: draft.draftId, path: skillPath, confirmed: true })
  await harness.call('POST', '/draft/commit', { draftId: draft.draftId, message: '创建 v2' })
  const before = await harness.call('GET', '/library')
  assert.equal(before.plan.currentVersion, 'v2')
  const preview = await harness.call('POST', '/version/rollback/preview', { planId, versionId: 'v1' })
  assert.equal(preview.confirmRequired, true)
  assert.equal(preview.currentVersion, 'v2')
  assert.equal(preview.sourceVersion, 'v1')
  assert.equal(preview.nextVersion, 'v3')
  assert.ok(preview.scope.some((item) => item.path === skillPath))
  assert.ok(preview.files.some((item) => item.path === skillPath && item.changeType === 'modified'))
  const resumed = createProductService({ packageRoot: process.cwd(), dataRoot: path.join(harness.root, 'data') })
  const persistedCall = (method, pathname, body = {}, query = {}) => resumed.handle({
    method,
    pathname,
    body,
    searchParams: new URLSearchParams(query)
  })
  await assert.rejects(
    persistedCall('POST', '/version/rollback', { previewId: preview.previewId, planHash: preview.planHash }),
    (error) => error.code === 'PRODUCT_ROLLBACK_CONFIRM_REQUIRED',
  )
  const stillV2 = await persistedCall('GET', '/library')
  assert.equal(stillV2.plan.currentVersion, 'v2')
  const rolled = await persistedCall('POST', '/version/rollback', { previewId: preview.previewId, planHash: preview.planHash, confirm: true })
  assert.equal(rolled.status, 'created-from-rollback')
  assert.equal(rolled.version.versionId, 'v3')
  assert.equal(rolled.version.rollbackOf, 'v1')
  const after = await persistedCall('GET', '/library')
  assert.equal(after.plan.currentVersion, 'v3')
  assert.equal(after.commitReceipt, null, 'rollback versions must not inherit the source draft receipt')
  assert.deepEqual(after.plan.versions.map((item) => item.versionId), ['v1', 'v2', 'v3'])
})

test('skip-worktree evidence materializes up to 120 real relative-path samples', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-dormant-'))
  const workspace = makeDormantWorkspace(root, 121)
  const service = createProductService({ packageRoot: process.cwd(), dataRoot: path.join(root, 'data') })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const analysis = await service.handle({ method: 'POST', pathname: '/analyze', body: { workspacePath: workspace }, searchParams: new URLSearchParams() })
  const dormant = analysis.systems.find((item) => item.kind === 'dormant')
  assert.ok(dormant)
  assert.equal(dormant.fileCount, 121)
  assert.equal(dormant.sampleCount, 120)
  assert.equal(dormant.samplePaths.length, 120)
  assert.equal(dormant.files.length, 120)
  assert.ok(dormant.samplePaths.every((item) => item.startsWith('.agents/skills/missing-') && item.endsWith('/SKILL.md')))
  assert.ok(!dormant.samplePaths.some((item) => item === 'git-index'))
})

test('AI draft carries selected file context, supports cancellation, and imports a completed result once', async (t) => {
  let state = 'running'
  let sessionNumber = 0
  const calls = []
  const executeTyped = async (command) => {
    calls.push(command)
    if (command.kind === 'chat') {
      sessionNumber += 1
      state = 'running'
      return { session: { id: `ai-${sessionNumber}`, status: 'running', capabilities: { canCancel: true } } }
    }
    if (command.kind === 'getSession') {
      return { session: { id: command.sessionId, status: state, lastMessage: '已生成结构化草稿', capabilities: { canCancel: state === 'running' } } }
    }
    if (command.kind === 'cancelSession') {
      state = 'cancelled'
      return { session: { id: command.sessionId, status: 'cancelled' } }
    }
    throw new Error(`unexpected command ${command.kind}`)
  }
  const harness = makeHarness(t, { executeTyped })
  const { planId, skillPath } = await initialize(harness)
  const draft = await harness.call('POST', '/library/draft', { planId, action: 'edit', path: skillPath })
  const running = await harness.call('POST', '/draft/ai', { draftId: draft.draftId, message: '整理说明', selectedFiles: [skillPath] })
  assert.ok(calls.find((command) => command.kind === 'chat').intent.includes(skillPath))
  assert.ok(calls.find((command) => command.kind === 'chat').worktree)
  const cancelled = await harness.call('POST', '/chat/cancel', { sessionId: running.chatId })
  assert.equal(cancelled.cancelled, true)

  const completedDraft = await harness.call('POST', '/library/draft', { planId, action: 'edit', path: skillPath })
  const completed = await harness.call('POST', '/draft/ai', { draftId: completedDraft.draftId, message: '更新说明', selectedFiles: [skillPath] })
  state = 'completed'
  const scope = calls.filter((command) => command.kind === 'chat' && command.worktree).at(-1)?.worktree
  // The service created the scope before calling the bridge. Populate only
  // the selected file, matching the runner's safe worktree contract.
  writeFile(path.join(scope, ...skillPath.split('/')), '# AI result\n')
  const firstStatus = await harness.call('GET', '/chat/status', {}, { sessionId: completed.chatId })
  const secondStatus = await harness.call('GET', '/chat/status', {}, { sessionId: completed.chatId })
  assert.equal(firstStatus.synchronizedDraft, true)
  assert.equal(secondStatus.synchronizedDraft, false)
  assert.equal(firstStatus.assistantMessage, secondStatus.assistantMessage)
})

test('AI keeps a multi-file draft strictly to the one checked file through provider output and commit', async (t) => {
  const calls = []
  const cachePath = 'skills/cache-control/SKILL.md'
  const backupPath = 'skills/backup-plans/SKILL.md'
  const executeTyped = async (command) => {
    calls.push(command)
    if (command.kind === 'chat') {
      // Simulate a provider that writes a wider result than the user allowed.
      writeFile(path.join(command.worktree, ...cachePath.split('/')), '# AI cache result\n')
      writeFile(path.join(command.worktree, ...backupPath.split('/')), '# AI unselected result\n')
      return { session: { id: 'ai-scoped-result', status: 'running' } }
    }
    if (command.kind === 'getSession') {
      return { session: { id: command.sessionId, status: 'completed', lastMessage: '已完成选中文件处理' } }
    }
    throw new Error(`unexpected command ${command.kind}`)
  }
  const harness = makeHarness(t, { executeTyped })
  const { planId } = await initialize(harness)
  writeFile(path.join(harness.workspace, '.agents', 'skills', 'cache-control', 'SKILL.md'), '# workspace cache change\n')
  writeFile(path.join(harness.workspace, '.agents', 'skills', 'backup-plans', 'SKILL.md'), '# workspace backup change\n')
  const analysis = await harness.call('POST', '/analyze', { workspacePath: harness.workspace })
  const comparison = await harness.call('POST', '/compare', {
    planId,
    analysisId: analysis.analysisId,
    workspacePath: harness.workspace,
    mode: 'update'
  })
  assert.ok(comparison.files.some((file) => file.path === cachePath))
  assert.ok(comparison.files.some((file) => file.path === backupPath))
  const draft = await harness.call('POST', '/library/draft', {
    comparisonId: comparison.comparisonId,
    planId,
    paths: [cachePath, backupPath],
    origin: 'workspace-review'
  })
  assert.deepEqual(draft.files.map((file) => file.path).sort(), [cachePath, backupPath].sort())

  const started = await harness.call('POST', '/draft/ai', {
    draftId: draft.draftId,
    message: '只整理缓存控制说明',
    selectedFiles: [cachePath]
  })
  const chatCommand = calls.find((command) => command.kind === 'chat')
  assert.ok(chatCommand?.worktree)
  const status = await harness.call('GET', '/chat/status', {}, { sessionId: started.chatId })
  assert.equal(status.synchronizedDraft, true)
  assert.deepEqual(status.selectedFiles, [cachePath])

  const narrowed = await harness.call('GET', '/draft', {}, { draftId: draft.draftId })
  assert.deepEqual(narrowed.files.map((file) => file.path), [cachePath])
  assert.deepEqual(narrowed.editablePaths, [cachePath])
  assert.equal(narrowed.files[0].content, '# AI cache result\n')
  assert.equal(narrowed.files.some((file) => file.path === backupPath), false)
  await harness.call('POST', '/draft/confirm', { draftId: draft.draftId, path: cachePath, confirmed: true })
  await harness.call('POST', '/draft/commit', { draftId: draft.draftId, message: '只保存勾选的 AI 文件' })

  const savedCache = await harness.call('GET', '/library/file', {}, { planId, path: cachePath })
  const savedBackup = await harness.call('GET', '/library/file', {}, { planId, path: backupPath })
  assert.equal(savedCache.content, '# AI cache result\n')
  assert.equal(savedBackup.content, '# legal backup-plans skill\n')
})

test('AI cancellation before the provider session id arrives cancels the late session and never imports its result', async (t) => {
  let releaseChat
  let chatStarted
  const chatGate = new Promise((resolve) => { releaseChat = resolve })
  const chatStartedGate = new Promise((resolve) => { chatStarted = resolve })
  const calls = []
  const executeTyped = async (command) => {
    calls.push(command)
    if (command.kind === 'chat') {
      chatStarted()
      return chatGate
    }
    if (command.kind === 'cancelSession') return { session: { id: command.sessionId, status: 'cancelled' } }
    if (command.kind === 'getSession') return { session: { id: command.sessionId, status: 'completed', lastMessage: 'late completed result' } }
    throw new Error(`unexpected command ${command.kind}`)
  }
  const harness = makeHarness(t, { executeTyped })
  const { planId, skillPath } = await initialize(harness)
  const draft = await harness.call('POST', '/library/draft', { planId, action: 'edit', path: skillPath })
  const requestId = 'race-request-before-session'
  const startPromise = harness.call('POST', '/draft/ai', {
    draftId: draft.draftId,
    message: '更新说明',
    selectedFiles: [skillPath],
    requestId
  })
  await chatStartedGate
  const earlyCancel = await harness.call('POST', '/chat/cancel', { requestId })
  assert.equal(earlyCancel.cancelled, true)
  assert.equal(earlyCancel.sessionId, null)
  assert.equal(calls.some((command) => command.kind === 'cancelSession'), false)

  const chatCommand = calls.find((command) => command.kind === 'chat')
  assert.ok(chatCommand?.worktree)
  writeFile(path.join(chatCommand.worktree, ...skillPath.split('/')), '# late result must not import\n')
  releaseChat({ session: { id: 'late-session', status: 'running', capabilities: { canCancel: true } } })
  const lateStart = await startPromise
  assert.equal(lateStart.cancelled, true)
  assert.equal(lateStart.chatId, 'late-session')
  assert.equal(calls.filter((command) => command.kind === 'cancelSession').length, 1)
  assert.equal(calls.find((command) => command.kind === 'cancelSession').sessionId, 'late-session')

  const status = await harness.call('GET', '/chat/status', {}, { sessionId: 'late-session' })
  assert.equal(status.cancelled, true)
  assert.equal(status.session.status, 'cancelled')
  assert.equal(status.assistantMessage, '', 'a late provider completion must not leak assistant text after cancel')
  assert.equal(status.synchronizedDraft, false)
  const unchangedDraft = await harness.call('GET', '/draft', {}, { draftId: draft.draftId })
  assert.equal(unchangedDraft.files[0].content, '# demo skill\n')
})

test('ordinary chat receives fresh authoritative current-library context without workspace private bodies', async (t) => {
  const calls = []
  let sessionNumber = 0
  const executeTyped = async (command) => {
    calls.push(command)
    if (command.kind !== 'chat') throw new Error(`unexpected command ${command.kind}`)
    sessionNumber += 1
    return { session: { id: `ordinary-chat-${sessionNumber}`, status: 'running' } }
  }
  const harness = makeHarness(t, { executeTyped })
  const { planId, system, skillPath } = await initialize(harness)

  const first = await harness.call('POST', '/chat', { message: '当前中心库有哪些内容？' })
  assert.equal(first.chatId, 'ordinary-chat-1')
  const firstIntent = calls[0].intent
  assert.equal(calls[0].worktree, undefined, 'ordinary chat must not receive a workspace scope')
  assert.match(firstIntent, /中心库权威只读上下文/u)
  assert.match(firstIntent, /当前版本：v1/u)
  assert.match(firstIntent, /当前内容计数：5 个文件，5 个 Skill，0 条 Rule/u)
  assert.match(firstIntent, /已选择体系与来源/u)
  assert.match(firstIntent, new RegExp(system.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.match(firstIntent, /当前版本逻辑路径（共 5 条/u)
  assert.match(firstIntent, new RegExp(skillPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.match(firstIntent, /当前中心库非空时不得声称为空/u)
  assert.match(firstIntent, /不得创建、写入或修改中心库/u)
  assert.doesNotMatch(firstIntent, /# demo skill/u, 'ordinary context must not include private file bodies')

  const created = await harness.call('POST', '/library/draft', {
    planId,
    action: 'create',
    path: 'skills/chat-context-new.md',
    content: '# current v2 path\n',
  })
  await harness.call('POST', '/draft/confirm', { draftId: created.draftId, path: 'skills/chat-context-new.md', confirmed: true })
  const committed = await harness.call('POST', '/draft/commit', { draftId: created.draftId, message: '刷新普通对话上下文' })
  assert.equal(committed.version.versionId, 'v2')

  await harness.call('POST', '/chat', { message: '再次说明当前中心库。' })
  const secondIntent = calls[1].intent
  assert.match(secondIntent, /当前版本：v2/u)
  assert.match(secondIntent, /当前内容计数：6 个文件，5 个 Skill，0 条 Rule/u)
  assert.match(secondIntent, /chat-context-new\.md/u)
  assert.doesNotMatch(secondIntent, /当前版本：v1/u)
})

test('ordinary chat explicitly reports an uninitialized center library', async (t) => {
  const calls = []
  const executeTyped = async (command) => {
    calls.push(command)
    if (command.kind !== 'chat') throw new Error(`unexpected command ${command.kind}`)
    return { session: { id: 'ordinary-chat-uninitialized', status: 'running' } }
  }
  const harness = makeHarness(t, { executeTyped })
  await harness.call('POST', '/chat', { message: '当前中心库有哪些内容？' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].intent, /中心库尚未初始化/u)
  assert.doesNotMatch(calls[0].intent, /当前中心库为空/u)
})
