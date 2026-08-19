import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHub } from '../dist/index.js'
import { createLinkPort } from '../dist/adapters/link/index.js'
import { createNodeFs } from '../dist/adapters/node-fs.js'
import { createNodePath } from '../dist/adapters/node-path.js'

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
