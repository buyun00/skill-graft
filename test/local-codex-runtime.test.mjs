import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  describeLocalCodexRuntime,
  resolveLocalCodexRuntime
} from '../dist/local/session/local-codex-runtime.js'

function runtimeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-local-codex-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageRoot = path.join(root, 'package')
  const appData = path.join(root, 'profile', 'appdata')
  const userProfile = path.join(root, 'profile')
  const codexModule = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  const credentialHome = path.join(userProfile, '.codex')
  const controllerPath = path.join(packageRoot, 'runtime', 'codex-runner-controller.ps1')
  for (const file of [codexModule, path.join(credentialHome, 'auth.json'), controllerPath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'fixture\n')
  }
  return { root, packageRoot, appData, userProfile, codexModule, credentialHome, controllerPath }
}

test('Local Codex runtime resolves standard paths only inside the supplied profile authority', (t) => {
  const fixture = runtimeFixture(t)
  const runtime = resolveLocalCodexRuntime({
    packageRoot: fixture.packageRoot,
    environment: {
      APPDATA: fixture.appData,
      USERPROFILE: fixture.userProfile,
      HUB_SPAWN_CODEX: '1'
    },
    allowStandardPaths: true,
    fallbackNodeExecutable: process.execPath
  })

  assert.equal(runtime.nodeExecutable, process.execPath)
  assert.equal(runtime.codexModule, fixture.codexModule)
  assert.equal(runtime.credentialHome, fixture.credentialHome)
  assert.equal(runtime.controllerPath, fixture.controllerPath)
  assert.equal(runtime.enabled, true)
  assert.equal(runtime.available, true)
  assert.equal(runtime.ready, true)
  assert.deepEqual(runtime.issues, [])
  assert.equal(describeLocalCodexRuntime(runtime), 'Session Runner ready')
})

test('Local Codex runtime does not discover standard profile paths unless trusted composition opts in', (t) => {
  const fixture = runtimeFixture(t)
  const runtime = resolveLocalCodexRuntime({
    packageRoot: fixture.packageRoot,
    environment: {
      APPDATA: fixture.appData,
      USERPROFILE: fixture.userProfile,
      HUB_SPAWN_CODEX: '1'
    },
    fallbackNodeExecutable: process.execPath
  })

  assert.equal(runtime.nodeExecutable, process.execPath)
  assert.equal(runtime.codexModule, '')
  assert.equal(runtime.credentialHome, '')
  assert.equal(runtime.available, false)
  assert.equal(runtime.ready, false)
  assert.deepEqual(runtime.issues, ['codex-module-unavailable', 'credential-unavailable'])
})

test('Local Codex runtime gives explicit HUB_CODEX paths priority over standard paths', (t) => {
  const fixture = runtimeFixture(t)
  const explicitRoot = path.join(fixture.root, 'explicit')
  const explicitNode = path.join(explicitRoot, 'node.exe')
  const explicitModule = path.join(explicitRoot, 'codex.js')
  const explicitCredentials = path.join(explicitRoot, 'credentials')
  for (const file of [explicitNode, explicitModule, path.join(explicitCredentials, 'auth.json')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'fixture\n')
  }
  const runtime = resolveLocalCodexRuntime({
    packageRoot: fixture.packageRoot,
    environment: {
      APPDATA: fixture.appData,
      USERPROFILE: fixture.userProfile,
      HUB_CODEX_NODE: explicitNode,
      HUB_CODEX_MODULE: explicitModule,
      HUB_CODEX_CREDENTIAL_HOME: explicitCredentials,
      HUB_SPAWN_CODEX: '1'
    },
    fallbackNodeExecutable: process.execPath
  })

  assert.equal(runtime.nodeExecutable, explicitNode)
  assert.equal(runtime.codexModule, explicitModule)
  assert.equal(runtime.credentialHome, explicitCredentials)
  assert.equal(runtime.ready, true)
})

test('Local Codex runtime fails closed for an explicit invalid path or missing auth', (t) => {
  const fixture = runtimeFixture(t)
  const missingCredentials = path.join(fixture.root, 'missing-credentials')
  fs.mkdirSync(missingCredentials, { recursive: true })
  const runtime = resolveLocalCodexRuntime({
    packageRoot: fixture.packageRoot,
    environment: {
      APPDATA: fixture.appData,
      USERPROFILE: fixture.userProfile,
      HUB_CODEX_MODULE: path.join('relative', 'codex.js'),
      HUB_CODEX_CREDENTIAL_HOME: missingCredentials,
      HUB_SPAWN_CODEX: '1'
    },
    fallbackNodeExecutable: process.execPath
  })

  assert.equal(runtime.codexModule, path.join('relative', 'codex.js'))
  assert.equal(runtime.credentialHome, missingCredentials)
  assert.equal(runtime.available, false)
  assert.equal(runtime.ready, false)
  assert.deepEqual(runtime.issues, ['codex-module-unavailable', 'credential-unavailable'])
  assert.match(describeLocalCodexRuntime(runtime), /CLI module.*credentials/i)
})

test('Local Codex runtime separates structural availability from an explicitly disabled runner', (t) => {
  const fixture = runtimeFixture(t)
  const runtime = resolveLocalCodexRuntime({
    packageRoot: fixture.packageRoot,
    environment: {
      APPDATA: fixture.appData,
      HOME: fixture.userProfile,
      HUB_SPAWN_CODEX: '0'
    },
    allowStandardPaths: true,
    fallbackNodeExecutable: process.execPath
  })

  assert.equal(runtime.credentialHome, fixture.credentialHome, 'HOME is the scoped non-Windows fallback')
  assert.equal(runtime.enabled, false)
  assert.equal(runtime.available, true)
  assert.equal(runtime.ready, false)
  assert.deepEqual(runtime.issues, ['runner-disabled'])
})
