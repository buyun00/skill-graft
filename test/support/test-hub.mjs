import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RESIDENT = ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']

function assertTemporaryRoot(root) {
  const resolved = path.resolve(root)
  const temp = path.resolve(os.tmpdir())
  const rel = path.relative(temp, resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`default tests require an owned temporary HUB_ROOT under ${temp}`)
  }
  return resolved
}

export function createTemporaryTestHub(sourceRoot) {
  const root = assertTemporaryRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-default-')))
  fs.mkdirSync(path.join(root, 'skill-review', 'history'), { recursive: true })
  fs.mkdirSync(path.join(root, 'skills', 'adopted'), { recursive: true })
  fs.mkdirSync(path.join(root, 'skills', 'inbox'), { recursive: true })
  fs.mkdirSync(path.join(root, 'overlay', 'prompts'), { recursive: true })
  for (const name of RESIDENT) {
    const dir = path.join(root, 'skills', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n\nTemporary default-test fixture.\n`, 'utf8')
  }
  fs.copyFileSync(path.join(sourceRoot, 'skills', 'README.md'), path.join(root, 'skills', 'README.md'))
  for (const name of [
    'checkout-rules.txt',
    'attach-library.ps1',
    'manage-skill-visibility.ps1',
    'analyze-remote-skill-update.ps1'
  ]) {
    fs.copyFileSync(path.join(sourceRoot, 'overlay', name), path.join(root, 'overlay', name))
  }
  for (const name of ['attach', 'detach', 'edit', 'chat', 'analyze']) {
    const source = path.join(sourceRoot, 'overlay', 'prompts', `${name}.txt`)
    const target = path.join(root, 'overlay', 'prompts', `${name}.txt`)
    fs.copyFileSync(source, target)
  }
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '# temporary default-test override\n', 'utf8')
  fs.writeFileSync(path.join(root, 'overlay', 'attached-worktrees.txt'), '', 'utf8')
  fs.writeFileSync(path.join(root, 'overlay', 'do-not-auto-attach.txt'), '', 'utf8')
  fs.writeFileSync(path.join(root, 'overlay', 'scan-roots.txt'), '', 'utf8')
  fs.writeFileSync(path.join(root, 'skill-review', 'state.json'), '{\n  "version": 1,\n  "lastIngest": null,\n  "items": []\n}\n', 'utf8')
  fs.writeFileSync(path.join(root, 'skill-review', 'sessions.json'), '{\n  "sessions": []\n}\n', 'utf8')
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

export function createTemporaryCliPackage(sourceRoot) {
  const root = assertTemporaryRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-cli-package-')))
  fs.cpSync(path.join(sourceRoot, 'dist'), path.join(root, 'dist'), { recursive: true })
  fs.cpSync(path.join(sourceRoot, 'server'), path.join(root, 'server'), { recursive: true })
  fs.cpSync(path.join(sourceRoot, 'overlay'), path.join(root, 'overlay'), { recursive: true })
  fs.copyFileSync(path.join(sourceRoot, 'AGENTS.override.md'), path.join(root, 'AGENTS.override.md'))
  for (const name of RESIDENT) {
    const dir = path.join(root, 'skills', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n\nTemporary packaged-skill fixture.\n`, 'utf8')
  }
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(root, 'package.json'))
  // The legacy setup path only checks for this directory before deciding to
  // invoke npm. An empty directory keeps the integration test fully offline.
  fs.mkdirSync(path.join(root, 'node_modules'))
  return {
    root,
    cliPath: path.join(root, 'dist', 'control', 'cli.js'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}
