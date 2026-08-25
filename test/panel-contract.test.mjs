import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { createPanelApi } from '../panel/lib/api.mjs'
import { mapDoctorDiagnostics } from '../panel/lib/diagnostics-view.mjs'
import { createMutationRetryRegistry } from '../panel/lib/mutation-retry.mjs'
import { codexSessionHref, queuedSessionView } from '../panel/lib/overview-mapping.mjs'
import { buildPaletteEntries, filterPaletteEntries } from '../panel/lib/palette.mjs'
import { hubRoot } from './helpers.mjs'

const DOCTOR_FIXTURE = {
  ok: false,
  hubRoot: 'C:\\hub',
  daemon: { ok: false, apiUrl: 'http://127.0.0.1:28765/api/health' },
  lifecycle: {
    manifest: true,
    ownership: false,
    lockHealthy: true,
    dataMarker: false,
    packageVersion: '2.0.0',
    installedVersion: '1.9.0',
    versionMatch: false,
    corpusEmpty: true,
    lockState: 'stale',
    walPending: true,
    durablePending: 3,
    reviewLocks: { active: 4, stale: 5, unverifiable: 6 }
  }
}

function walkFiles(dir, predicate = () => true, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'out') continue
    const full = path.join(dir, name)
    const stat = fs.lstatSync(full)
    if (stat.isDirectory()) walkFiles(full, predicate, acc)
    else if (stat.isFile() && predicate(full)) acc.push(full)
  }
  return acc
}

function panelSources() {
  return [
    ...walkFiles(path.join(hubRoot, 'panel', 'src'), (file) => /\.(ts|tsx)$/.test(file)),
    ...walkFiles(path.join(hubRoot, 'panel', 'lib'), (file) => /\.mjs$/.test(file))
  ].map((file) => fs.readFileSync(file, 'utf8')).join('\n')
}

function session(kind, id = `session-${kind}`) {
  return {
    id,
    kind,
    status: 'running',
    canResume: false
  }
}

function applicationData(kind, body) {
  const plan = {
    planHash: body.planHash || 'sha256:plan',
    migrationId: body.migrationId || 'sha256:migration',
    executable: true,
    summary: { create: 1, update: 0, delete: 0, keep: 0, conflict: 0 },
    operations: [],
    git: { configuration: { action: 'keep', conflictKind: null, effects: [] } }
  }
  switch (kind) {
    case 'status': return { hubRoot: 'C:\\hub', counts: { resident: 1, adopted: 0, queued: 0, proposed: 0 }, items: [] }
    case 'listWorktrees': return { scanRoots: [], worktrees: [] }
    case 'readSkill': return { path: body.path, content: '# skill' }
    case 'listHistory': return { records: [{ id: 'history-1', type: 'sync' }] }
    case 'listSessions': return { sessions: [session('chat', 'session-1')] }
    case 'getSession': return { session: session('chat', body.sessionId) }
    case 'listSnapshots': return { snapshots: [{ snapshotId: 'sha256:snapshot', createdAt: '2000-01-01T00:00:00.000Z', files: [] }] }
    case 'getPin': return { worktree: body.worktree, pathKey: 'sha256:path', worktreeId: 'worktree-1', pin: null }
    case 'setPin': return { action: 'setPin', changed: true, pin: { requestedSnapshot: body.snapshotId, selectedSkills: body.selectedSkills } }
    case 'planSync': return { action: 'planSync', status: 'planned', plan }
    case 'sync': return { action: 'sync', changed: true, planHash: body.planHash }
    case 'migrateLegacy':
      return {
        action: kind,
        mode: body.mode,
        status: body.mode === 'dryRun' ? 'planned' : 'committed',
        plan: body.mode === 'dryRun' ? plan : null,
        migration: body.mode === 'commit' ? { migrationId: 'sha256:migration' } : null,
        pin: null
      }
    case 'rollbackLegacyMigration':
      return {
        action: kind,
        mode: body.mode,
        status: body.mode === 'dryRun' ? 'planned' : 'rolled-back',
        plan: body.mode === 'dryRun' ? plan : null,
        migration: { migrationId: body.migrationId },
        pin: null
      }
    case 'attach':
    case 'detach':
    case 'analyze':
    case 'chat':
    case 'resumeSession':
    case 'cancelSession':
      return {
        action: kind,
        session: session(kind, kind === 'resumeSession' || kind === 'cancelSession' ? body.sessionId : undefined),
        applied: null
      }
    case 'decide': return { action: body.action, item: { id: body.id, status: body.action }, worktrees: { applied: [], skipped: [] } }
    default: return { accepted: kind }
  }
}

function envelope(kind, body, data = applicationData(kind, body)) {
  return {
    contractVersion: 1,
    requestId: body.requestId,
    commandKind: kind,
    ok: true,
    data,
    events: [],
    meta: { replayed: false, handler: 'application.commandBus' }
  }
}

async function listenRecorder() {
  const seen = []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    let body = {}
    if (req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      body = raw ? JSON.parse(raw) : {}
    }
    seen.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      headers: req.headers,
      body
    })
    let payload
    if (url.pathname === '/api/health') {
      payload = { ok: true }
    } else if (url.pathname === '/api/host/diagnostics') {
      payload = DOCTOR_FIXTURE
    } else if (url.pathname === '/api/command') {
      payload = envelope(body.kind, body)
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { code: 'HTTP_NOT_FOUND', message: 'not found' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return { server, seen, base: `http://127.0.0.1:${address.port}` }
}

function commandBodies(seen, kind) {
  return seen
    .filter((item) => item.path === '/api/command' && item.body.kind === kind)
    .map((item) => item.body)
}

function withoutGeneratedRequestId(body) {
  assert.equal(typeof body.requestId, 'string')
  assert.ok(body.requestId.length > 8)
  const { requestId: _requestId, ...rest } = body
  return rest
}

test('panel API uses the typed Application envelope for Local operations', async (t) => {
  const { server, seen, base } = await listenRecorder()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const api = createPanelApi({ base })
  const worktree = 'C:\\worktree'

  assert.deepEqual(await api.getHealth(), { ok: true })
  const diagnostics = await api.getDiagnostics()
  assert.equal(diagnostics.ok, false)
  assert.equal((await api.getDaemon()).ok, false)
  await api.getState()
  await api.getWorktrees()
  await api.getSkill('skills/ozdqp-development')
  await api.getHistory()
  await api.getSessions()
  await api.getSession('session-1')
  await api.getSnapshots()
  await api.getPin(worktree)
  const pin = await api.setPin(worktree, 'sha256:snapshot', ['alpha', 'beta'], { requestId: 'pin-request' })
  const planned = await api.planSync(worktree)
  await api.sync(worktree, planned.plan.planHash, undefined, { requestId: 'sync-request' })
  await api.migrateLegacy(worktree, 'dryRun', undefined, { requestId: 'migration-plan-request' })
  await api.migrateLegacy(worktree, 'commit', 'sha256:migration-plan', { requestId: 'migration-commit-request' })
  await api.rollbackLegacy(worktree, 'sha256:migration', 'dryRun', undefined, { requestId: 'rollback-plan-request' })
  await api.rollbackLegacy(worktree, 'sha256:migration', 'commit', 'sha256:rollback-plan', { requestId: 'rollback-commit-request' })
  await api.decide('inbox-1', 'reject')
  const analyzed = await api.analyze({ inboxId: 'inbox-1' })
  const attached = await api.attachWorktree(worktree, 'contract attach')
  const detached = await api.detachWorktree(worktree, 'contract detach')
  const started = await api.startCodex({ kind: 'chat', intent: 'hello' })
  const resumed = await api.resumeCodex('session-1', 'continue')
  const cancelled = await api.cancelCodex('session-1', 'panel requested cancellation')

  assert.equal(seen.filter((item) => item.path === '/api/health' && item.method === 'GET').length, 1)
  assert.equal(seen.filter((item) => item.path === '/api/host/diagnostics' && item.method === 'GET').length, 2)
  assert.ok(seen.filter((item) => item.path === '/api/command').every((item) => (
    item.method === 'POST'
    && /^application\/json/.test(String(item.headers['content-type']))
  )))

  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'status')[0]), { kind: 'status' })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'listWorktrees')[0]), { kind: 'listWorktrees' })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'readSkill')[0]), {
    kind: 'readSkill',
    path: 'skills/ozdqp-development'
  })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'listHistory')[0]), { kind: 'listHistory', limit: 50 })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'listSessions')[0]), { kind: 'listSessions' })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'getSession')[0]), {
    kind: 'getSession',
    sessionId: 'session-1'
  })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'listSnapshots')[0]), { kind: 'listSnapshots' })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'getPin')[0]), { kind: 'getPin', worktree })
  assert.deepEqual(commandBodies(seen, 'setPin')[0], {
    kind: 'setPin',
    worktree,
    snapshotId: 'sha256:snapshot',
    selectedSkills: ['alpha', 'beta'],
    requestId: 'pin-request'
  })
  assert.deepEqual(commandBodies(seen, 'sync')[0], {
    kind: 'sync',
    worktree,
    planHash: 'sha256:plan',
    requestId: 'sync-request'
  })
  assert.deepEqual(commandBodies(seen, 'migrateLegacy'), [
    { kind: 'migrateLegacy', worktree, mode: 'dryRun', requestId: 'migration-plan-request' },
    {
      kind: 'migrateLegacy',
      worktree,
      mode: 'commit',
      planHash: 'sha256:migration-plan',
      requestId: 'migration-commit-request'
    }
  ])
  assert.deepEqual(commandBodies(seen, 'rollbackLegacyMigration'), [
    {
      kind: 'rollbackLegacyMigration',
      worktree,
      migrationId: 'sha256:migration',
      mode: 'dryRun',
      requestId: 'rollback-plan-request'
    },
    {
      kind: 'rollbackLegacyMigration',
      worktree,
      migrationId: 'sha256:migration',
      mode: 'commit',
      planHash: 'sha256:rollback-plan',
      requestId: 'rollback-commit-request'
    }
  ])
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'decide')[0]), {
    kind: 'decide',
    id: 'inbox-1',
    action: 'reject'
  })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'analyze')[0]), {
    kind: 'analyze',
    intent: 'Analyze queued inbox skill updates',
    runner: { start: true },
    inboxId: 'inbox-1'
  })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'attach')[0]), {
    kind: 'attach',
    worktree,
    intent: 'contract attach'
  })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'detach')[0]), {
    kind: 'detach',
    worktree,
    intent: 'contract detach'
  })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'chat')[0]), {
    kind: 'chat',
    intent: 'hello',
    runner: {}
  })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'resumeSession')[0]), {
    kind: 'resumeSession',
    sessionId: 'session-1',
    message: 'continue'
  })
  assert.deepEqual(withoutGeneratedRequestId(commandBodies(seen, 'cancelSession')[0]), {
    kind: 'cancelSession',
    sessionId: 'session-1',
    reason: 'panel requested cancellation'
  })

  assert.equal(pin.changed, true)
  assert.equal(queuedSessionView(attached).label, '已入队')
  assert.equal(queuedSessionView(detached).label, '已入队')
  assert.equal(queuedSessionView(analyzed).id, 'session-analyze')
  assert.equal(started.id, 'session-chat')
  assert.equal(codexSessionHref(started), '/codex?id=session-chat')
  assert.equal(resumed.id, 'session-1')
  assert.equal(cancelled.id, 'session-1')
  assert.equal(api.sessionStreamUrl('abc'), `${base}/api/codex/session/stream?id=abc`)
})

test('panel preserves structured transport and Application failures', async () => {
  const transportApi = createPanelApi({
    fetch: async () => new Response(JSON.stringify({
      transportVersion: 1,
      ok: false,
      error: { code: 'HTTP_CAPABILITY_REQUIRED', message: 'capability required' }
    }), { status: 403, headers: { 'Content-Type': 'application/json' } })
  })
  await assert.rejects(
    transportApi.getState(),
    (error) => error.status === 403 && error.code === 'HTTP_CAPABILITY_REQUIRED'
  )

  const applicationApi = createPanelApi({
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body)
      return new Response(JSON.stringify({
        contractVersion: 1,
        requestId: body.requestId,
        commandKind: body.kind,
        ok: false,
        error: { code: 'CONFLICT', message: 'material conflict' },
        events: [],
        meta: { replayed: false, handler: 'application.commandBus' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  })
  await assert.rejects(
    applicationApi.planSync('C:\\worktree'),
    (error) => error.code === 'CONFLICT' && /^panel-planSync-/.test(error.requestId)
  )

  const invalidApi = createPanelApi({
    fetch: async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  })
  await assert.rejects(
    invalidApi.getState(),
    (error) => error.code === 'PANEL_INVALID_ENVELOPE'
  )
})

test('network-uncertain mutations reuse requestId and exact planHash for one business effect', async () => {
  const cases = [
    {
      key: 'setPin',
      fingerprint: 'pin-input-v1',
      expected: { kind: 'setPin', snapshotId: 'sha256:snapshot' },
      invoke: (api, options) => api.setPin('C:\\worktree', 'sha256:snapshot', ['alpha'], options)
    },
    {
      key: 'sync',
      fingerprint: 'sync-plan-v1',
      expected: { kind: 'sync', planHash: 'sha256:sync-plan' },
      invoke: (api, options) => api.sync('C:\\worktree', 'sha256:sync-plan', undefined, options)
    },
    {
      key: 'migrateCommit',
      commandKind: 'migrateLegacy',
      fingerprint: 'migration-plan-v1',
      expected: { kind: 'migrateLegacy', mode: 'commit', planHash: 'sha256:migration-plan' },
      invoke: (api, options) => api.migrateLegacy('C:\\worktree', 'commit', 'sha256:migration-plan', options)
    },
    {
      key: 'rollbackCommit',
      commandKind: 'rollbackLegacyMigration',
      fingerprint: 'rollback-plan-v1',
      expected: {
        kind: 'rollbackLegacyMigration',
        mode: 'commit',
        migrationId: 'sha256:migration',
        planHash: 'sha256:rollback-plan'
      },
      invoke: (api, options) => api.rollbackLegacy(
        'C:\\worktree',
        'sha256:migration',
        'commit',
        'sha256:rollback-plan',
        options
      )
    }
  ]

  for (const scenario of cases) {
    const attempts = []
    const durableRequestIds = new Set()
    let effects = 0
    const api = createPanelApi({
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body)
        attempts.push(body)
        if (!durableRequestIds.has(body.requestId)) {
          durableRequestIds.add(body.requestId)
          effects += 1
        }
        if (attempts.length === 1) throw new TypeError('socket closed after durable commit')
        return new Response(JSON.stringify(envelope(body.kind, body, { replayed: true })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
    })
    let idSequence = 0
    const retry = createMutationRetryRegistry({
      createRequestId: () => `${scenario.key}-frozen-${++idSequence}`
    })
    const executeClick = () => scenario.invoke(api, {
      requestId: retry.requestId(
        scenario.key,
        scenario.fingerprint,
        scenario.commandKind || scenario.key
      )
    })

    await assert.rejects(executeClick(), /socket closed after durable commit/)
    await executeClick()
    assert.equal(effects, 1, `${scenario.key} must have one durable business effect`)
    assert.equal(attempts.length, 2)
    assert.deepEqual(attempts[1], attempts[0], `${scenario.key} retry body`)
    assert.equal(attempts[0].requestId, `${scenario.key}-frozen-1`)
    for (const [key, value] of Object.entries(scenario.expected)) {
      assert.deepEqual(attempts[0][key], value, `${scenario.key}.${key}`)
    }

    retry.clear(scenario.key, scenario.fingerprint)
    assert.equal(
      retry.requestId(scenario.key, scenario.fingerprint, scenario.commandKind || scenario.key),
      `${scenario.key}-frozen-2`,
      `${scenario.key} success/replan releases the semantic request id`
    )
  }
})

test('host diagnostics view preserves every lifecycle fact and explicit API endpoint', () => {
  const view = mapDoctorDiagnostics(DOCTOR_FIXTURE)
  assert.equal(view.ok, false, 'doctor.ok is rendered, never recomputed')
  assert.equal(view.apiPort, '28765')
  assert.equal(view.apiUrl, 'http://127.0.0.1:28765/api/health')
  assert.deepEqual(view.lifecycle, {
    manifest: true,
    ownership: false,
    lockHealthy: true,
    dataMarker: false,
    packageVersion: '2.0.0',
    installedVersion: '1.9.0',
    versionMatch: false,
    corpusEmpty: true,
    lockState: 'stale',
    walPending: true,
    durablePending: 3,
    reviewLocks: { active: 4, stale: 5, unverifiable: 6 }
  })

  const settings = fs.readFileSync(
    path.join(hubRoot, 'panel', 'src', 'components', 'pages', 'SettingsView.tsx'),
    'utf8'
  )
  for (const field of [
    'API port',
    'API URL',
    'manifest',
    'ownership',
    'lockHealthy',
    'dataMarker',
    'packageVersion',
    'installedVersion',
    'versionMatch',
    'corpusEmpty',
    'lockState',
    'walPending',
    'durablePending',
    'reviewLocks.active',
    'reviewLocks.stale',
    'reviewLocks.unverifiable'
  ]) assert.match(settings, new RegExp(field.replace('.', '\\.')), field)
})

test('palette entries come from skills + worktrees + updates with router hrefs', () => {
  const entries = buildPaletteEntries({
    state: {
      resident: [{ name: 'ozdqp-development', path: 'skills/ozdqp-development', kind: 'resident' }],
      adopted: [{ name: 'extra', path: 'skills/adopted/extra', kind: 'adopted' }],
      inbox: [{ name: 'archify', path: 'skills/inbox/archify', kind: 'inbox' }],
      items: [{ id: 'u-dev', name: 'ozdqp-development', status: 'queued' }]
    },
    worktrees: { worktrees: [{ name: 'probe', path: 'C:\\worktree' }] }
  })
  const hrefs = entries.map((item) => item.href)
  assert.ok(hrefs.includes('/skills?path=skills%2Fozdqp-development'))
  assert.ok(hrefs.includes('/workspaces?path=C%3A%5Cworktree'))
  assert.ok(hrefs.includes('/updates/u-dev'))
  const filtered = filterPaletteEntries(entries, 'probe')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].href, '/workspaces?path=C%3A%5Cworktree')
})

test('panel sources are typed-transport renderers and close terminal EventSource streams', () => {
  const source = panelSources()
  assert.match(source, /\/api\/command/)
  assert.match(source, /\/api\/host\/diagnostics/)
  for (const kind of [
    'getPin',
    'setPin',
    'planSync',
    'sync',
    'migrateLegacy',
    'rollbackLegacyMigration',
    'listHistory'
  ]) {
    assert.match(source, new RegExp(`['\"]${kind}['\"]`), kind)
  }
  assert.match(source, /createMutationRetryRegistry/)
  assert.match(source, /EventSource/)
  assert.match(source, /addEventListener\("session"/)
  assert.match(source, /addEventListener\("end"/)
  assert.match(source, /cancelSession/)
  assert.match(source, /source\.close\(\)/)
  assert.doesNotMatch(source, /\/api\/(?:state|worktrees|decide|analyze|codex\/start|codex\/resume|worktree\/attach|worktree\/detach)/)
  assert.doesNotMatch(source, /src\/core/)
  assert.doesNotMatch(source, /preferLibrary/)
  assert.doesNotMatch(source, /inode/)
  assert.doesNotMatch(source, /认仓/)
  assert.doesNotMatch(source, /createHub/)
  assert.doesNotMatch(source, /from ['\"]node:fs['\"]/)
})

test('vendored glass dependency is content-pinned and build scripts have no adjacent-repo fallback', () => {
  const panelRoot = path.join(hubRoot, 'panel')
  const vendorRoot = path.join(panelRoot, 'vendor', 'graft-glass-ui')
  const provenance = JSON.parse(fs.readFileSync(path.join(vendorRoot, 'PROVENANCE.json'), 'utf8'))
  const declared = new Map(provenance.files.map((item) => [item.path, item.sha256]))
  const actual = walkFiles(path.join(vendorRoot, 'src'), () => true)
    .map((file) => path.relative(vendorRoot, file).replaceAll(path.sep, '/'))
    .sort()
  assert.deepEqual([...declared.keys()].sort(), actual)
  for (const relative of actual) {
    const digest = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(vendorRoot, ...relative.split('/'))))
      .digest('hex')
    assert.equal(digest, declared.get(relative), relative)
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(panelRoot, 'package.json'), 'utf8'))
  const packageLock = JSON.parse(fs.readFileSync(path.join(panelRoot, 'package-lock.json'), 'utf8'))
  assert.equal(packageJson.dependencies['graft-glass-ui'], 'file:./vendor/graft-glass-ui')
  assert.equal(packageLock.packages[''].dependencies['graft-glass-ui'], 'file:./vendor/graft-glass-ui')
  assert.equal(packageLock.packages['node_modules/graft-glass-ui'].resolved, 'vendor/graft-glass-ui')
  assert.equal(packageLock.packages['vendor/graft-glass-ui'].version, '0.1.0-vendored')

  const buildInputs = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'next.config.mjs',
    'tailwind.config.ts',
    'scripts/export-web.mjs'
  ].map((file) => fs.readFileSync(path.join(panelRoot, file), 'utf8')).join('\n')
  assert.doesNotMatch(buildInputs, /\.\.[\\\/]\.\.[\\\/]graft-glass-ui/)
  assert.doesNotMatch(buildInputs, /[A-Za-z]:[\\\/][^\n]*graft-glass-ui/i)
  const exportScript = fs.readFileSync(path.join(panelRoot, 'scripts', 'export-web.mjs'), 'utf8')
  const verifyScript = fs.readFileSync(path.join(panelRoot, 'scripts', 'verify-out.mjs'), 'utf8')
  const releaseScript = fs.readFileSync(path.join(hubRoot, 'scripts', 'build-release.mjs'), 'utf8')
  assert.equal(packageJson.scripts['verify:out'], 'node ./scripts/verify-out.mjs')
  assert.match(exportScript, /require\.resolve\('next\/dist\/bin\/next'\)/)
  assert.match(exportScript, /spawnSync\(process\.execPath/)
  assert.match(exportScript, /scripts['"], 'verify-out\.mjs'/)
  assert.doesNotMatch(exportScript, /\bnpx\b/)
  assert.doesNotMatch(exportScript, /shell:\s*true/)
  assert.match(releaseScript, /process\.env\.npm_execpath/)
  assert.match(releaseScript, /spawnSync\(npmCommand/)
  assert.doesNotMatch(releaseScript, /spawnSync\(['"]npm\.cmd['"]/)
  assert.doesNotMatch(releaseScript, /shell:\s*true/)
  assert.match(verifyScript, /production export is missing the typed command endpoint/)
  assert.match(verifyScript, /production export contains an adjacent-repository glass dependency/)
})
