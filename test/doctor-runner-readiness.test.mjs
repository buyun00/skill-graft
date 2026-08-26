import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createInstallHost } from '../dist/adapters/install-host.js'
import { collectDoctorFacts } from '../dist/control/install.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('collectDoctorFacts projects the shared complete Runner readiness instead of CLI presence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-doctor-runner-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataRoot = path.join(root, 'data')
  const userProfile = path.join(root, 'profile')
  const appData = path.join(userProfile, 'AppData', 'Roaming')
  const codexModule = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  const credentialHome = path.join(userProfile, '.codex')
  fs.mkdirSync(path.dirname(codexModule), { recursive: true })
  fs.writeFileSync(codexModule, 'fixture\n')
  fs.mkdirSync(credentialHome, { recursive: true })
  fs.writeFileSync(path.join(credentialHome, 'auth.json'), '{"fixture":true}\n')
  const environment = {
    APPDATA: appData,
    USERPROFILE: userProfile,
    HOME: userProfile,
    LOCALAPPDATA: path.join(userProfile, 'AppData', 'Local'),
    SG_INSTALL_DIR: path.join(root, 'install'),
    HUB_SPAWN_CODEX: '1'
  }
  const host = createInstallHost({
    platform: 'win32',
    home: userProfile,
    localAppData: environment.LOCALAPPDATA,
    environment: () => environment,
    which: () => '',
    taskExists: () => false,
    pidAlive: () => false
  })

  const ready = collectDoctorFacts(packageRoot, host, dataRoot, environment)
  assert.equal(ready.codexPath, codexModule)
  assert.equal(ready.codexRunnerReady, true)
  assert.equal(ready.codexRunnerDetail, 'Session Runner ready')

  fs.rmSync(path.join(credentialHome, 'auth.json'))
  const cliOnly = collectDoctorFacts(packageRoot, host, dataRoot, environment)
  assert.equal(cliOnly.codexPath, codexModule)
  assert.equal(cliOnly.codexRunnerReady, false)
  assert.match(cliOnly.codexRunnerDetail, /credentials are unavailable/i)
})
