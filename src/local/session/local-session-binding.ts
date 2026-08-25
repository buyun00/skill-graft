import fs from 'node:fs'
import path from 'node:path'
import type { LocalHostContext } from '../../adapters/host-context.js'
import type { SessionStartRequest } from '../../application/ports.js'
import type { SessionTask } from '../../contracts/index.js'
import type { LocalRunnerArtifacts } from './types.js'

export type LocalSessionBinding = {
  sessionId: string
  attemptId: string
  task: SessionTask
  locator?: SessionStartRequest['locator']
  workingDirectory: string
  additionalDirectories: readonly string[]
  environment: Readonly<Record<string, string>>
  artifacts: LocalRunnerArtifacts
}

export type LocalSessionBindingPort = {
  prepare(input: {
    sessionId: string
    attemptId: string
    task: SessionTask
    locator?: SessionStartRequest['locator']
  }): LocalSessionBinding
  read(sessionId: string, attemptId: string): LocalSessionBinding | null
}

export type LocalSessionBindingOptions = {
  packageRoot: string
  nodeExecutable: string
  credentialHome: string
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} is not a safe local session identifier`)
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function bindingInstructions(
  ctx: LocalHostContext,
  options: LocalSessionBindingOptions,
  task: SessionTask,
  locator?: SessionStartRequest['locator']
): readonly string[] {
  const cli = `${quote(options.nodeExecutable)} ${quote(path.join(options.packageRoot, 'dist', 'control', 'cli.js'))}`
  const target = locator ? quote(locator.value) : ''
  switch (task.kind) {
    case 'attach':
      return [
        `The host-bound worktree is ${target}. Inspect it only as needed.`,
        `Run exactly one trusted snapshot command: ${cli} snapshot create --request-id ${quote(`attach-snapshot-${task.id}`)} --contract-v1.`,
        'After the command succeeds, stop. Claim and materialization remain Application-owned and this session remains awaiting.'
      ]
    case 'detach':
      return [
        `The host-bound worktree is ${target}.`,
        `Use only this trusted detach command: ${cli} apply-legacy-detach --worktree ${target} --session-id ${quote(task.id)} --request-id ${quote(`detach-apply-${task.id}`)} --contract-v1.`
      ]
    case 'edit':
      return [`The host-bound Skill path is ${target}. Do not edit outside that Skill directory.`]
    case 'chat':
      return locator ? [`The host-bound worktree available to this request is ${target}.`] : []
    case 'analyze':
      return ['The host-bound inbox data is available under the Skill Graft data root.']
  }
}

function renderPrompt(
  ctx: LocalHostContext,
  options: LocalSessionBindingOptions,
  task: SessionTask,
  locator?: SessionStartRequest['locator']
): string {
  const business = [task.prompt.summary, ...task.prompt.instructions]
  const local = bindingInstructions(ctx, options, task, locator)
  return [
    'Session task (Application-owned):',
    ...business.map((line) => `- ${line}`),
    '',
    'Local execution binding (host-owned):',
    `- Session id: ${task.id}`,
    `- Skill Graft data root: ${ctx.hubRoot}`,
    ...local.map((line) => `- ${line}`),
    '',
    'Use structured command results for execution decisions. Do not infer completion from narrative output.'
  ].join('\n')
}

export function createLocalSessionBinding(
  ctx: LocalHostContext,
  options: LocalSessionBindingOptions
): LocalSessionBindingPort {
  const rootFor = (sessionId: string, attemptId: string) => path.join(
    ctx.hubRoot,
    'skill-review',
    'sessions',
    sessionId,
    'attempts',
    attemptId
  )

  const bindingPath = (sessionId: string, attemptId: string) => path.join(rootFor(sessionId, attemptId), 'binding.json')

  return {
    prepare(input) {
      assertSafeId(input.sessionId, 'sessionId')
      assertSafeId(input.attemptId, 'attemptId')
      const attemptRoot = rootFor(input.sessionId, input.attemptId)
      const sessionRoot = path.dirname(path.dirname(attemptRoot))
      const codexHome = path.join(sessionRoot, 'codex-home')
      const isolatedHome = path.join(sessionRoot, 'home')
      const isolatedTemp = path.join(isolatedHome, 'Temp')
      fs.mkdirSync(attemptRoot, { recursive: true })
      fs.mkdirSync(codexHome, { recursive: true })
      fs.mkdirSync(isolatedHome, { recursive: true })
      fs.mkdirSync(isolatedTemp, { recursive: true })

      const authSource = path.isAbsolute(options.credentialHome)
        ? path.join(options.credentialHome, 'auth.json')
        : ''
      const authTarget = path.join(codexHome, 'auth.json')
      if (!fs.existsSync(authTarget) && authSource && fs.existsSync(authSource)) {
        fs.copyFileSync(authSource, authTarget, fs.constants.COPYFILE_EXCL)
      }

      const artifacts: LocalRunnerArtifacts = {
        attemptRoot,
        requestPath: path.join(attemptRoot, 'request.json'),
        promptPath: path.join(attemptRoot, 'prompt.txt'),
        stdoutPath: path.join(attemptRoot, 'stdout.log'),
        stderrPath: path.join(attemptRoot, 'stderr.log'),
        eventsPath: path.join(attemptRoot, 'events.jsonl'),
        lastMessagePath: path.join(attemptRoot, 'last-message.txt'),
        cancelPath: path.join(attemptRoot, 'cancel.json'),
        statusPath: path.join(attemptRoot, 'status.json'),
        receiptPath: path.join(attemptRoot, 'receipt.json'),
        launchPath: path.join(attemptRoot, 'launch.json'),
        codexHome,
        isolatedHome
      }
      const additionalDirectories = input.locator?.kind === 'worktree'
        ? [input.locator.value]
        : []
      const value: LocalSessionBinding = {
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        task: input.task,
        locator: input.locator,
        workingDirectory: ctx.hubRoot,
        additionalDirectories,
        environment: {
          CODEX_HOME: codexHome,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
          LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
          XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
          TEMP: isolatedTemp,
          TMP: isolatedTemp,
          SKILL_GRAFT_HOME: ctx.hubRoot,
          HUB_ROOT: ctx.hubRoot
        },
        artifacts
      }
      fs.writeFileSync(artifacts.promptPath, `${renderPrompt(ctx, options, input.task, input.locator)}\n`, 'utf8')
      fs.writeFileSync(bindingPath(input.sessionId, input.attemptId), `${JSON.stringify(value)}\n`, 'utf8')
      return value
    },
    read(sessionId, attemptId) {
      assertSafeId(sessionId, 'sessionId')
      assertSafeId(attemptId, 'attemptId')
      const file = bindingPath(sessionId, attemptId)
      if (!fs.existsSync(file)) return null
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8')) as LocalSessionBinding
        return value.sessionId === sessionId && value.attemptId === attemptId ? value : null
      } catch {
        return null
      }
    }
  }
}
