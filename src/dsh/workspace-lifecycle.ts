import type { HubCommand, HubCommandResult, Sha256Identifier } from '../contracts/index.js'
import type { DshHost } from './create-dsh-host.js'

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_PROMPT_FILE_BYTES = 2 * 1024 * 1024

export type DshAutoSyncMode = 'off' | 'plan' | 'sync'

export type DshSettingsValue = {
  workspaceId: string
  autoSync: DshAutoSyncMode
}

export type DshSettingsScope = {
  get(): DshSettingsValue
  watch(callback: (next: DshSettingsValue, previous: DshSettingsValue) => void | Promise<void>): () => void
  update(patch: Partial<DshSettingsValue>): Promise<void>
}

export type DshWorkspace = {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionIds: readonly string[]
  status(): Promise<'ok' | 'missing-dir'>
}

export type DshWorkspaceRegistry = {
  list(): DshWorkspace[]
  get(id: string): DshWorkspace | undefined
  create(path: string, title?: string): Promise<DshWorkspace>
  delete(id: string): Promise<boolean>
}

export type DshRuntimeSkill = {
  name: string
  description: string
  whenToUse?: string
  source: 'runtime'
  provider: 'skill-graft'
  content: string
  resourceBase: { kind: 'opaque'; description: string }
}

export type DshSkillsRegistry = {
  register(skill: DshRuntimeSkill): () => void
}

export type DshSystemPrompt = {
  section(input: { name: string; order: number; text: string }): () => void
}

export type DshWorkspaceProjection = {
  id: string
  path: string
  title: string
  status: 'ok' | 'missing-dir' | 'unavailable'
  sessionCount: number
}

export type DshWorkspaceUiState = {
  generatedAt: string
  settings: {
    dataRoot: string
    workspaceId: string
    autoSync: DshAutoSyncMode
    lockTimeoutMs: number
    logLevel: 'error' | 'warn' | 'info' | 'debug'
  }
  workspaces: readonly DshWorkspaceProjection[]
  selectedWorkspace: DshWorkspaceProjection | null
  requiresExplicitSelection: boolean
  registeredSkills: readonly {
    name: string
    snapshotId: Sha256Identifier
  }[]
  overrideSnapshotId: Sha256Identifier | null
  facts: {
    status: HubCommandResult | null
    schema: HubCommandResult | null
    inventory: HubCommandResult | null
    snapshots: HubCommandResult | null
    history: HubCommandResult | null
    pin: HubCommandResult | null
    plan: HubCommandResult | null
    sync: HubCommandResult | null
  }
  doctor: {
    ok: boolean
    issues: readonly string[]
  }
}

export type DshWorkspaceLifecycle = {
  describe(): DshWorkspaceUiState
  refresh(signal?: AbortSignal): Promise<DshWorkspaceUiState>
  updateSettings(patch: Partial<DshSettingsValue>, signal?: AbortSignal): Promise<DshWorkspaceUiState>
  selectWorkspace(workspaceId: string, signal?: AbortSignal): Promise<DshWorkspaceUiState>
  registerWorkspace(path: string, title?: string, signal?: AbortSignal): Promise<DshWorkspaceUiState>
  unregisterWorkspace(workspaceId: string, signal?: AbortSignal): Promise<DshWorkspaceUiState>
  dispose(): Promise<void>
}

export type CreateDshWorkspaceLifecycleOptions = {
  host: DshHost
  settings: DshSettingsScope
  workspaceRegistry: DshWorkspaceRegistry
  skills: DshSkillsRegistry
  systemPrompt: DshSystemPrompt
  configuredWorkspace?: string
  lockTimeoutMs: number
  logLevel: 'error' | 'warn' | 'info' | 'debug'
}

type PreparedBindings = {
  snapshotId: Sha256Identifier | null
  skills: readonly DshRuntimeSkill[]
  overrideText: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('DSH workspace operation was cancelled')
  error.name = 'AbortError'
  throw error
}

function successData(result: HubCommandResult | null): Record<string, unknown> | null {
  if (!result?.ok || !isRecord(result.data)) return null
  return result.data
}

function normalizedScalar(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'string') return parsed
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

function parseSkillDocument(text: string, expectedName: string): {
  description: string
  whenToUse?: string
  content: string
} {
  const withoutBom = text.replace(/^\uFEFF/, '')
  const lines = withoutBom.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return {
      description: `Skill Graft snapshot skill ${expectedName}`,
      content: withoutBom
    }
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close < 0) throw new Error(`snapshot Skill ${expectedName} has unterminated frontmatter`)
  const fields = new Map<string, string>()
  for (let index = 1; index < close; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[index] || '')
    if (!match) continue
    const key = match[1].toLowerCase()
    let value = match[2]
    if (value === '>' || value === '|') {
      const continuation: string[] = []
      while (index + 1 < close && /^\s+/.test(lines[index + 1] || '')) {
        continuation.push((lines[index + 1] || '').trim())
        index += 1
      }
      value = continuation.join(value === '>' ? ' ' : '\n')
    }
    fields.set(key, normalizedScalar(value))
  }
  const declaredName = fields.get('name')
  if (declaredName && declaredName !== expectedName) {
    throw new Error(`snapshot Skill ${expectedName} declares a different name`)
  }
  const description = fields.get('description')?.trim() || `Skill Graft snapshot skill ${expectedName}`
  const whenToUse = fields.get('whentouse')?.trim() || fields.get('when-to-use')?.trim()
  return {
    description,
    ...(whenToUse ? { whenToUse } : {}),
    content: lines.slice(close + 1).join('\n')
  }
}

function decoded(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength > MAX_PROMPT_FILE_BYTES) throw new Error(`${label} exceeds the two MiB prompt boundary`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
}

function selectedPin(result: HubCommandResult | null): {
  claimState: string
  materializedSnapshot: Sha256Identifier | null
  selectedSkills: readonly string[]
} | null {
  const data = successData(result)
  const pin = data && isRecord(data.pin) ? data.pin : null
  if (!pin || typeof pin.claimState !== 'string') return null
  const materialized = pin.materializedSnapshot
  const materializedSnapshot = typeof materialized === 'string' && SHA256_PATTERN.test(materialized)
    ? materialized as Sha256Identifier
    : null
  const selectedSkills = Array.isArray(pin.selectedSkills)
    ? pin.selectedSkills.filter((entry): entry is string => typeof entry === 'string')
    : []
  return { claimState: pin.claimState, materializedSnapshot, selectedSkills }
}

function executablePlan(result: HubCommandResult | null): { planHash: Sha256Identifier } | null {
  const data = successData(result)
  const plan = data && isRecord(data.plan) ? data.plan : null
  if (data?.status !== 'planned' || !plan || plan.executable !== true
    || typeof plan.planHash !== 'string' || !SHA256_PATTERN.test(plan.planHash)) return null
  return { planHash: plan.planHash as Sha256Identifier }
}

function materializedMarker(result: HubCommandResult | null): {
  snapshotId: Sha256Identifier
  selectedSkills: readonly string[]
} | null {
  const data = successData(result)
  const plan = data && isRecord(data.plan) ? data.plan : null
  const current = plan && isRecord(plan.current) ? plan.current : null
  if (!plan || plan.markerStatus !== 'valid' || !current
    || typeof current.snapshotId !== 'string' || !SHA256_PATTERN.test(current.snapshotId)
    || !Array.isArray(current.selectedSkills)
    || current.selectedSkills.some((entry) => typeof entry !== 'string')) return null
  return {
    snapshotId: current.snapshotId as Sha256Identifier,
    selectedSkills: current.selectedSkills as string[]
  }
}

async function prepareBindings(
  host: DshHost,
  planResult: HubCommandResult | null
): Promise<PreparedBindings> {
  const marker = materializedMarker(planResult)
  if (!marker) {
    return { snapshotId: null, skills: [], overrideText: null }
  }
  const manifest = await host.snapshots.read(marker.snapshotId)
  if (!manifest) throw new Error('materialized snapshot is unavailable')
  const read = async (relativePath: string): Promise<string | null> => {
    const file = manifest.files.find((entry) => entry.path === relativePath)
    if (!file) return null
    const bytes = await host.snapshots.readVerifiedFile({
      snapshotId: manifest.snapshotId,
      path: file.path,
      expectedSize: file.size,
      expectedSha256: file.sha256
    })
    if (!bytes) throw new Error(`snapshot content disappeared: ${relativePath}`)
    return decoded(bytes, relativePath)
  }
  const skills: DshRuntimeSkill[] = []
  const seen = new Set<string>()
  for (const name of marker.selectedSkills) {
    if (!SKILL_NAME_PATTERN.test(name) || seen.has(name)) {
      throw new Error('pin contains an invalid or duplicate Skill name')
    }
    seen.add(name)
    const residentPath = `skills/${name}/SKILL.md`
    const adoptedPath = `skills/adopted/${name}/SKILL.md`
    const resident = manifest.files.some((entry) => entry.path === residentPath)
    const adopted = manifest.files.some((entry) => entry.path === adoptedPath)
    if (resident === adopted) throw new Error(`snapshot does not identify exactly one source for Skill ${name}`)
    const content = await read(resident ? residentPath : adoptedPath)
    if (content === null) throw new Error(`snapshot is missing SKILL.md for ${name}`)
    const parsed = parseSkillDocument(content, name)
    skills.push({
      name,
      description: parsed.description,
      ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
      source: 'runtime',
      provider: 'skill-graft',
      content: parsed.content,
      resourceBase: {
        kind: 'opaque',
        description: `Skill Graft materialized snapshot ${manifest.snapshotId}`
      }
    })
  }
  return {
    snapshotId: manifest.snapshotId,
    skills,
    overrideText: await read('AGENTS.override.md')
  }
}

function copyState(state: DshWorkspaceUiState): DshWorkspaceUiState {
  return structuredClone(state)
}

export function createDshWorkspaceLifecycle(
  options: CreateDshWorkspaceLifecycleOptions
): DshWorkspaceLifecycle {
  let disposed = false
  let operationTail = Promise.resolve<void>(undefined)
  let skillDisposers: Array<() => void> = []
  let promptDisposer: (() => void) | undefined
  let stopWatch: (() => void) | undefined
  let currentState: DshWorkspaceUiState = {
    generatedAt: new Date(0).toISOString(),
    settings: {
      dataRoot: options.host.dataRoot,
      workspaceId: '',
      autoSync: 'off',
      lockTimeoutMs: options.lockTimeoutMs,
      logLevel: options.logLevel
    },
    workspaces: [],
    selectedWorkspace: null,
    requiresExplicitSelection: false,
    registeredSkills: [],
    overrideSnapshotId: null,
    facts: {
      status: null,
      schema: null,
      inventory: null,
      snapshots: null,
      history: null,
      pin: null,
      plan: null,
      sync: null
    },
    doctor: { ok: true, issues: [] }
  }

  const command = (kind: HubCommand['kind'], payload: Record<string, unknown> = {}, signal?: AbortSignal) => {
    // Cancellation is honored until the shared Application accepts a command.
    // Once accepted, its idempotent/atomic write boundary must finish rather
    // than being interrupted into a partially persisted state.
    throwIfAborted(signal)
    return options.host.application.execute({
      kind,
      ...payload,
      meta: options.host.commandMeta('dsh-workspace-lifecycle')
    } as HubCommand)
  }

  const enqueue = <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const accepted = () => {
      throwIfAborted(signal)
      return operation()
    }
    const result = operationTail.then(accepted, accepted)
    operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  const clearBindings = (): void => {
    for (const dispose of skillDisposers.splice(0).reverse()) dispose()
    promptDisposer?.()
    promptDisposer = undefined
  }

  const swapBindings = (prepared: PreparedBindings): void => {
    clearBindings()
    const next: Array<() => void> = []
    try {
      for (const skill of prepared.skills) next.push(options.skills.register(skill))
      const nextPrompt = prepared.overrideText === null
        ? undefined
        : options.systemPrompt.section({
          name: 'skill-graft:workspace-override',
          order: 15,
          text: prepared.overrideText
        })
      skillDisposers = next
      promptDisposer = nextPrompt
    } catch (error) {
      for (const dispose of next.reverse()) dispose()
      throw error
    }
  }

  const configuredMatch = (workspaces: readonly DshWorkspaceProjection[]): DshWorkspaceProjection | undefined => {
    const configured = options.configuredWorkspace?.trim()
    if (!configured) return undefined
    const configuredPath = options.host.context.path.comparisonKey(options.host.context.path.resolve(configured))
    return workspaces.find((workspace) => workspace.id === configured
      || options.host.context.path.comparisonKey(options.host.context.path.resolve(workspace.path)) === configuredPath)
  }

  const refreshNow = async (signal?: AbortSignal): Promise<DshWorkspaceUiState> => {
    throwIfAborted(signal)
    if (disposed) throw new Error('DSH workspace lifecycle is disposed')
    const setting = options.settings.get()
    const rawWorkspaces = options.workspaceRegistry.list()
    const workspaces = await Promise.all(rawWorkspaces.map(async (workspace): Promise<DshWorkspaceProjection> => {
      let status: DshWorkspaceProjection['status'] = 'unavailable'
      try {
        status = await workspace.status()
      } catch {
        status = 'unavailable'
      }
      return {
        id: String(workspace.id),
        path: workspace.path,
        title: workspace.title,
        status,
        sessionCount: workspace.sessionIds.length
      }
    }))
    const savedId = setting.workspaceId.trim()
    const saved = savedId ? workspaces.find((workspace) => workspace.id === savedId) : undefined
    const selected = saved || (!savedId ? configuredMatch(workspaces) : undefined)
      || (!savedId && !options.configuredWorkspace?.trim() && workspaces.length === 1 ? workspaces[0] : undefined)
    const issues: string[] = []
    if (savedId && !saved) issues.push('The selected DSH workspace is no longer registered.')
    if (!selected && workspaces.length > 1) issues.push('Choose a workspace explicitly; multiple DSH workspaces are registered.')
    if (!selected && workspaces.length === 0) issues.push('Register a DSH workspace before using pin or sync.')
    if (selected?.status !== undefined && selected.status !== 'ok') {
      issues.push('The selected workspace directory is unavailable.')
    }

    let status = await command('status', {}, signal)
    const schema = await command('inspectSchema', {}, signal)
    let inventory = await command('listSkills', {}, signal)
    const snapshots = await command('listSnapshots', {}, signal)
    let history = await command('listHistory', { limit: 50 }, signal)
    let pin: HubCommandResult | null = null
    let plan: HubCommandResult | null = null
    let sync: HubCommandResult | null = null
    if (selected?.status === 'ok') {
      pin = await command('getPin', { worktree: selected.path }, signal)
      const selectedPinState = pin.ok ? selectedPin(pin) : null
      if (!selectedPinState || selectedPinState.claimState !== 'claimed') {
        issues.push('The selected workspace is not claimed; a real attach flow is required before pin or sync.')
      } else {
        plan = await command('planSync', { worktree: selected.path }, signal)
        const executable = executablePlan(plan)
        if (setting.autoSync === 'sync' && executable) {
          sync = await command('sync', { worktree: selected.path, planHash: executable.planHash }, signal)
          status = await command('status', {}, signal)
          inventory = await command('listSkills', {}, signal)
          history = await command('listHistory', { limit: 50 }, signal)
          pin = await command('getPin', { worktree: selected.path }, signal)
          plan = await command('planSync', { worktree: selected.path }, signal)
        }
      }
    }
    for (const [label, result] of [
      ['status', status],
      ['schema', schema],
      ['inventory', inventory],
      ['snapshots', snapshots],
      ['history', history],
      ['pin', pin]
    ] as const) {
      if (result && !result.ok) issues.push(`${label}: ${result.error.code}`)
    }

    let prepared: PreparedBindings = { snapshotId: null, skills: [], overrideText: null }
    try {
      throwIfAborted(signal)
      prepared = await prepareBindings(options.host, plan)
      throwIfAborted(signal)
      swapBindings(prepared)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      clearBindings()
      issues.push(`snapshot registration: ${errorMessage(error)}`)
    }
    currentState = {
      generatedAt: new Date().toISOString(),
      settings: {
        dataRoot: options.host.dataRoot,
        workspaceId: setting.workspaceId,
        autoSync: setting.autoSync,
        lockTimeoutMs: options.lockTimeoutMs,
        logLevel: options.logLevel
      },
      workspaces,
      selectedWorkspace: selected || null,
      requiresExplicitSelection: !selected && workspaces.length > 1,
      registeredSkills: prepared.snapshotId === null
        ? []
        : prepared.skills.map((skill) => ({ name: skill.name, snapshotId: prepared.snapshotId as Sha256Identifier })),
      overrideSnapshotId: prepared.overrideText === null ? null : prepared.snapshotId,
      facts: { status, schema, inventory, snapshots, history, pin, plan, sync },
      doctor: { ok: issues.length === 0, issues }
    }
    return copyState(currentState)
  }

  const refresh = (signal?: AbortSignal): Promise<DshWorkspaceUiState> => (
    enqueue(() => refreshNow(signal), signal)
  )
  stopWatch = options.settings.watch(async () => { await refresh() })

  return {
    describe: () => copyState(currentState),
    refresh,
    updateSettings(patch, signal) {
      const allowed = Object.keys(patch)
      if (allowed.some((key) => key !== 'workspaceId' && key !== 'autoSync')) {
        return Promise.reject(new Error('unsupported Skill Graft setting'))
      }
      if (patch.workspaceId !== undefined && (typeof patch.workspaceId !== 'string' || patch.workspaceId.length > 512)) {
        return Promise.reject(new Error('workspaceId is invalid'))
      }
      if (patch.autoSync !== undefined && !['off', 'plan', 'sync'].includes(patch.autoSync)) {
        return Promise.reject(new Error('autoSync is invalid'))
      }
      try {
        throwIfAborted(signal)
      } catch (error) {
        return Promise.reject(error)
      }
      return options.settings.update(patch).then(() => refresh(signal))
    },
    selectWorkspace(workspaceId, signal) {
      if (typeof workspaceId !== 'string' || workspaceId.length > 512) {
        return Promise.reject(new Error('workspaceId is invalid'))
      }
      const normalized = workspaceId.trim()
      if (normalized && !options.workspaceRegistry.get(normalized)) {
        return Promise.reject(new Error('workspaceId is not registered'))
      }
      try {
        throwIfAborted(signal)
      } catch (error) {
        return Promise.reject(error)
      }
      return options.settings.update({ workspaceId: normalized }).then(() => refresh(signal))
    },
    async registerWorkspace(inputPath, title, signal) {
      if (typeof inputPath !== 'string' || !inputPath.trim() || inputPath.length > 4096) {
        throw new Error('workspace path is invalid')
      }
      if (title !== undefined && (typeof title !== 'string' || title.length > 512)) {
        throw new Error('workspace title is invalid')
      }
      throwIfAborted(signal)
      const workspace = await options.workspaceRegistry.create(inputPath.trim(), title?.trim() || undefined)
      await options.settings.update({ workspaceId: String(workspace.id) })
      return await refresh(signal)
    },
    async unregisterWorkspace(workspaceId, signal) {
      if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 512) {
        throw new Error('workspaceId is invalid')
      }
      const normalized = workspaceId.trim()
      throwIfAborted(signal)
      const removed = await options.workspaceRegistry.delete(normalized)
      if (!removed) throw new Error('workspaceId is not registered')
      if (options.settings.get().workspaceId === normalized) await options.settings.update({ workspaceId: '' })
      return await refresh(signal)
    },
    dispose: () => enqueue(async () => {
      if (disposed) return
      disposed = true
      stopWatch?.()
      stopWatch = undefined
      clearBindings()
    })
  }
}
