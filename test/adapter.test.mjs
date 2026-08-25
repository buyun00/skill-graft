import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHub } from '../dist/index.js'
import { createLinkPort } from '../dist/adapters/link/index.js'
import { createNodeFs } from '../dist/adapters/node-fs.js'
import { createNodePath } from '../dist/adapters/node-path.js'
import { createPersistentRequestLedger } from '../dist/adapters/persistent-request-ledger.js'
import { createLocalQueryPort } from '../dist/adapters/local-query-port.js'
import { createLocalUseCasePorts } from '../dist/adapters/local-use-case-ports.js'
import { worktreeTargetId } from '../dist/adapters/worktree-target.js'

test('A1 win32 samePath folds case', () => {
  const win = createLinkPort(createNodeFs(), createNodePath(), 'win32')
  assert.equal(win.samePath('E:\\foo', 'e:\\FOO'), true)
  assert.equal(win.samePath('E:\\ozdqp-main-fix', 'e:\\OZDQP-main-fix'), true)
})

test('A2 linux samePath does not fold case', () => {
  const linux = createLinkPort(createNodeFs(), createNodePath(), 'linux')
  assert.equal(linux.samePath('/tmp/A', '/tmp/a'), false)
})

test('A3 darwin samePath folds case', () => {
  const darwin = createLinkPort(createNodeFs(), createNodePath(), 'darwin')
  assert.equal(darwin.samePath('/tmp/Foo', '/tmp/foo'), true)
  assert.equal(darwin.samePath('/Users/Hub/Repo', '/users/hub/repo'), true)
})

test('A3b host path containment and opaque worktree identity preserve POSIX case distinctions', () => {
  const linux = createNodePath('linux')
  const win32 = createNodePath('win32')
  assert.equal(linux.isSameOrInside('/Root', '/root/secret'), false)
  assert.equal(linux.isSameOrInside('/Root', '/Root/child'), true)
  assert.equal(win32.isSameOrInside('C:\\Root', 'c:\\root\\child'), true)
  assert.equal(win32.comparisonKey('C:\\'), 'c:\\')

  const context = {
    path: linux,
    hash: { sha256: (value) => value === '/Root' ? 'a'.repeat(64) : 'b'.repeat(64) }
  }
  assert.notEqual(worktreeTargetId(context, '/Root'), worktreeTargetId(context, '/root'))
})

test('A3c Local reads reject lexical and canonical escapes on a case-sensitive host', () => {
  const pathPort = createNodePath('linux')
  const nodes = new Map([
    ['/Root', 'dir'],
    ['/root/secret', 'file'],
    ['/Root/linked-skill', 'dir'],
    ['/Root/linked-skill/SKILL.md', 'file']
  ])
  const context = {
    hubRoot: '/Root',
    path: pathPort,
    fs: {
      exists: (target) => nodes.has(pathPort.resolve(target)),
      isDirectory: (target) => nodes.get(pathPort.resolve(target)) === 'dir',
      readText: (target) => nodes.has(pathPort.resolve(target)) ? 'outside bytes' : null,
      realpath(target) {
        const resolved = pathPort.resolve(target)
        if (resolved === '/Root/linked-skill/SKILL.md') return '/outside/SKILL.md'
        return nodes.has(resolved) ? resolved : null
      }
    }
  }
  const query = createLocalQueryPort(context)
  assert.deepEqual(query.readSkill('../root/secret'), { status: 'invalid-path', reason: 'escaped' })
  assert.deepEqual(query.readSkill('linked-skill'), { status: 'invalid-path', reason: 'escaped-link' })
})

test('A3d Local effects reject a canonical case-distinct linked ancestor before mutation', () => {
  const pathPort = createNodePath('linux')
  let removes = 0
  const exists = new Set(['/Root', '/Root/linked'])
  const context = {
    hubRoot: '/Root',
    path: pathPort,
    fs: {
      exists: (target) => exists.has(pathPort.resolve(target)),
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
      realpath(target) {
        const resolved = pathPort.resolve(target)
        if (resolved === '/Root/linked') return '/root'
        return exists.has(resolved) ? resolved : null
      },
      remove() { removes += 1 }
    },
    link: {
      samePath: (left, right) => pathPort.comparisonKey(left) === pathPort.comparisonKey(right)
    }
  }
  const ports = createLocalUseCasePorts(context)
  assert.throws(
    () => ports.artifacts.apply([{ kind: 'remove', target: { scope: 'hub', segments: ['linked', 'child'] } }]),
    /linked ancestor/
  )
  assert.equal(removes, 0)
})

test('A4 HardLink isLinked is true', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hard-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'source.txt')
  const hard = path.join(dir, 'hard.txt')
  fs.writeFileSync(source, 'hub-override')
  fs.linkSync(source, hard)
  const hub = createHub(dir)
  assert.equal(hub.link.isLinked(hard, source), true)
})

test('A5 Junction or symlink isLinked when the host allows it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-symlink-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const targetDir = path.join(dir, 'target')
  const linkDir = path.join(dir, 'link')
  fs.mkdirSync(targetDir)
  fs.writeFileSync(path.join(targetDir, 'f.txt'), 'hub')

  let linked = ''
  let expected = ''
  for (const type of ['junction', 'dir']) {
    try {
      fs.symlinkSync(targetDir, linkDir, type)
      linked = linkDir
      expected = targetDir
      break
    } catch {
      // try the next link type
    }
  }
  if (!linked) {
    const source = path.join(dir, 'source.txt')
    const fileLink = path.join(dir, 'source.link')
    fs.writeFileSync(source, 'hub')
    try {
      fs.symlinkSync(source, fileLink)
      linked = fileLink
      expected = source
    } catch (error) {
      t.skip(`cannot create junction/symlink: ${error.code || error.message}`)
      return
    }
  }

  const hub = createHub(dir)
  assert.equal(hub.link.isLinked(linked, expected), true)
})

test('A10 LinkPort creates and deletes a file link; target bytes stay', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-linkfile-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'source.txt')
  const linked = path.join(dir, 'linked.txt')
  fs.writeFileSync(source, 'hub-file-bytes')
  const hub = createHub(dir)
  hub.link.linkFile(linked, source)
  assert.equal(hub.link.isLinked(linked, source), true)
  assert.equal(fs.readFileSync(linked, 'utf8'), 'hub-file-bytes')
  hub.link.unlink(linked)
  assert.equal(hub.link.isLinked(linked, source), false)
  assert.equal(fs.existsSync(linked), false)
  assert.equal(fs.readFileSync(source, 'utf8'), 'hub-file-bytes')
})

test('A11 LinkPort creates and deletes a directory link; target files stay', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-linkdir-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'target')
  const linked = path.join(dir, 'linked')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'kept.txt'), 'hub-dir-bytes')
  const hub = createHub(dir)
  hub.link.linkDirectory(linked, target)
  assert.equal(hub.link.isLinked(linked, target), true)
  assert.equal(fs.readFileSync(path.join(linked, 'kept.txt'), 'utf8'), 'hub-dir-bytes')
  hub.link.unlink(linked)
  assert.equal(hub.link.isLinked(linked, target), false)
  assert.equal(fs.existsSync(linked), false)
  assert.equal(fs.readFileSync(path.join(target, 'kept.txt'), 'utf8'), 'hub-dir-bytes')
})

test('A6 missing file is empty, not a thrown business error', () => {
  const missing = path.join(os.tmpdir(), `hub-missing-${Date.now()}`, 'nope.txt')
  const other = `${missing}.other`
  const hub = createHub(os.tmpdir())
  assert.equal(hub.fs.exists(missing), false)
  assert.equal(hub.fs.readText(missing), null)
  assert.equal(hub.fs.statId(missing), null)
  assert.equal(hub.link.isLinked(missing, other), false)
})

test('A7 readList drops blank lines and # comments', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-list-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'names.txt')
  fs.writeFileSync(file, '# comment\n\nE:\\foo\n  \n# another\nE:\\bar\n')
  const hub = createHub(dir)
  assert.deepEqual(hub.persist.readList(file), ['E:\\foo', 'E:\\bar'])
})

test('A8 readState missing file is empty; bad JSON throws', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-state-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hub = createHub(dir)
  assert.deepEqual(hub.persist.readState(path.join(dir, 'missing.json')), {
    version: 1,
    items: [],
    lastIngest: null
  })
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, '{not json')
  assert.throws(() => hub.persist.readState(bad))
})

test('A9 git failure is null or empty string, not thrown', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-nogit-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hub = createHub(dir)
  assert.equal(hub.git.configGet(dir, 'ozdqp.gameRepo'), null)
  assert.equal(hub.git.output(dir, ['rev-parse', 'HEAD']), '')
})

test('A12 persistent replay outcomes and redacted audit events use separate files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ledger-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hub = createHub(dir)
  const ledger = createPersistentRequestLedger(hub)
  const started = {
    requestId: 'separate-files',
    digest: 'digest',
    commandKind: 'chat',
    status: 'started',
    startedAt: '2000-01-01T00:00:00.000Z'
  }
  const sensitive = 'do-not-copy-this-session-intent'
  const result = {
    contractVersion: 1,
    requestId: started.requestId,
    commandKind: 'chat',
    ok: true,
    data: { action: 'chat', session: { id: 'session-safe', kind: 'chat', status: 'queued', startedAt: started.startedAt, canResume: false } },
    events: [],
    meta: { replayed: false, handler: 'application.commandBus' }
  }
  const event = {
    eventVersion: 1,
    id: 'audit-1',
    type: 'command.succeeded',
    at: '2000-01-01T00:00:01.000Z',
    requestId: started.requestId,
    hostId: 'test',
    transport: 'memory',
    commandKind: 'chat',
    outcome: 'succeeded'
  }
  ledger.begin(started)
  ledger.complete({ ...started, status: 'completed', completedAt: event.at, result }, event)

  const replayFile = path.join(dir, 'skill-review', 'application-ledger.json')
  const auditFile = path.join(dir, 'skill-review', 'application-audit.json')
  const replay = JSON.parse(fs.readFileSync(replayFile, 'utf8'))
  const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8'))
  assert.deepEqual(Object.keys(replay).sort(), ['entries', 'version'])
  assert.deepEqual(Object.keys(audit).sort(), ['events', 'version'])
  assert.equal(JSON.stringify(replay).includes(sensitive), false)
  assert.equal(JSON.stringify(audit).includes(sensitive), false)
  assert.equal(JSON.stringify(audit).includes('session-safe'), false)
  assert.deepEqual(ledger.listEvents(10), [event])
})

test('A13 first new claim migrates legacy combined audit events before rewriting the ledger', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ledger-migrate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const review = path.join(dir, 'skill-review')
  fs.mkdirSync(review, { recursive: true })
  const legacyEvent = {
    eventVersion: 1,
    id: 'legacy-audit',
    type: 'command.succeeded',
    at: '2000-01-01T00:00:00.000Z',
    requestId: 'legacy-request',
    hostId: 'legacy',
    transport: 'cli',
    commandKind: 'chat',
    outcome: 'succeeded'
  }
  fs.writeFileSync(path.join(review, 'application-ledger.json'), `${JSON.stringify({ version: 1, entries: [], events: [legacyEvent] })}\n`)
  const ledger = createPersistentRequestLedger(createHub(dir))
  ledger.begin({
    requestId: 'new-request',
    digest: 'new-digest',
    commandKind: 'chat',
    status: 'started',
    startedAt: '2000-01-01T00:00:01.000Z'
  })
  const replay = JSON.parse(fs.readFileSync(path.join(review, 'application-ledger.json'), 'utf8'))
  const audit = JSON.parse(fs.readFileSync(path.join(review, 'application-audit.json'), 'utf8'))
  assert.deepEqual(Object.keys(replay).sort(), ['entries', 'version'])
  assert.deepEqual(audit.events, [legacyEvent])
  assert.deepEqual(ledger.listEvents(10), [legacyEvent])
})
