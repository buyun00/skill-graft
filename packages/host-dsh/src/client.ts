import * as React from 'react'

export const inject = ['connection', 'slots']

type SkillGraftApi = {
  execute(command: unknown, signal?: AbortSignal): Promise<any>
  executeFromSession(parentSessionId: string, command: unknown, signal?: AbortSignal): Promise<any>
  describe(signal?: AbortSignal): Promise<any>
  refresh(signal?: AbortSignal): Promise<any>
  updateSettings(patch: unknown, signal?: AbortSignal): Promise<any>
  selectWorkspace(workspaceId: string, signal?: AbortSignal): Promise<any>
  registerWorkspace(path: string, title?: string, signal?: AbortSignal): Promise<any>
  unregisterWorkspace(workspaceId: string, signal?: AbortSignal): Promise<any>
}

const h = React.createElement

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'grid', gap: 16, padding: '4px 2px 24px', color: 'var(--dsh-color-text, inherit)' },
  heading: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' },
  card: {
    display: 'grid', gap: 10, padding: 14, borderRadius: 10,
    border: '1px solid var(--dsh-color-border, rgba(127,127,127,.3))',
    background: 'var(--dsh-color-surface, rgba(127,127,127,.05))'
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 },
  row: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  input: {
    minWidth: 180, flex: '1 1 180px', padding: '7px 9px', borderRadius: 6,
    border: '1px solid var(--dsh-color-border, rgba(127,127,127,.4))',
    color: 'inherit', background: 'var(--dsh-color-surface, transparent)'
  },
  button: {
    padding: '7px 11px', borderRadius: 6, cursor: 'pointer',
    border: '1px solid var(--dsh-color-border, rgba(127,127,127,.4))',
    color: 'inherit', background: 'var(--dsh-color-surface-raised, rgba(127,127,127,.12))'
  },
  danger: { color: 'var(--dsh-color-danger, #d33)' },
  ok: { color: 'var(--dsh-color-success, #16843b)' },
  muted: { opacity: 0.72, fontSize: 12 },
  pre: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 280, overflow: 'auto', fontSize: 12 },
  list: { display: 'grid', gap: 8, margin: 0, padding: 0, listStyle: 'none' }
}

function rpcError(result: any): string {
  if (result?.error?.message) return String(result.error.message)
  return 'DSH RPC returned an error'
}

function hubError(result: any): string {
  if (result?.error?.message) return `${String(result.error.code || 'error')}: ${String(result.error.message)}`
  return 'Skill Graft Application returned an error'
}

function successData(result: any): any {
  return result?.ok === true ? result.data : undefined
}

function button(label: string, onClick: () => void, disabled = false, extra: React.CSSProperties = {}) {
  return h('button', {
    type: 'button', disabled, onClick,
    style: { ...styles.button, ...extra }
  }, label)
}

function field(label: string, control: React.ReactNode, hint?: string) {
  return h('label', { style: { display: 'grid', gap: 5 } },
    h('span', { style: { fontWeight: 600, fontSize: 13 } }, label),
    control,
    hint ? h('span', { style: styles.muted }, hint) : null)
}

function factLine(label: string, value: unknown) {
  return h('div', null,
    h('strong', null, `${label}: `),
    h('span', null, value === null || value === undefined || value === '' ? '—' : String(value)))
}

function SkillGraftPanel({ api }: { api: SkillGraftApi }) {
  const [state, setState] = React.useState<any>(null)
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [lastResult, setLastResult] = React.useState<any>(null)
  const [workspacePath, setWorkspacePath] = React.useState('')
  const [workspaceTitle, setWorkspaceTitle] = React.useState('')
  const [snapshotId, setSnapshotId] = React.useState('')
  const [selectedSkills, setSelectedSkills] = React.useState('')
  const [inboxPayload, setInboxPayload] = React.useState('')
  const [inboxGameRepo, setInboxGameRepo] = React.useState('')
  const [mergeTarget, setMergeTarget] = React.useState('')
  const [skillDetail, setSkillDetail] = React.useState<any>(null)
  const [sessionIntent, setSessionIntent] = React.useState('')
  const [resumeMessage, setResumeMessage] = React.useState('Continue this Skill Graft task.')
  const [selectedSessionId, setSelectedSessionId] = React.useState('')
  const activeControllers = React.useRef(new Set<AbortController>())

  const applyState = React.useCallback((next: any) => {
    setState(next)
    const pin = successData(next?.facts?.pin)?.pin
    if (pin?.requestedSnapshot) setSnapshotId(String(pin.requestedSnapshot))
    if (Array.isArray(pin?.selectedSkills)) setSelectedSkills(pin.selectedSkills.join(', '))
  }, [])

  const invoke = React.useCallback(async (label: string, operation: (signal: AbortSignal) => Promise<any>) => {
    const controller = new AbortController()
    activeControllers.current.add(controller)
    setBusy(label)
    setError('')
    try {
      const outer = await operation(controller.signal)
      if (outer?.ok !== true) throw new Error(rpcError(outer))
      return outer.value
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      if (!controller.signal.aborted) setError(message)
      throw caught
    } finally {
      activeControllers.current.delete(controller)
      if (!controller.signal.aborted) setBusy('')
    }
  }, [])

  React.useEffect(() => () => {
    for (const controller of activeControllers.current) controller.abort()
    activeControllers.current.clear()
  }, [])

  const reload = React.useCallback(async () => {
    try {
      const next = await invoke('refresh', signal => api.refresh(signal))
      applyState(next)
    } catch {
      // Visible error state is set by invoke.
    }
  }, [api, applyState, invoke])

  React.useEffect(() => {
    const controller = new AbortController()
    setBusy('load')
    api.describe(controller.signal).then((outer) => {
      if (outer?.ok !== true) throw new Error(rpcError(outer))
      applyState(outer.value)
      setError('')
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught))
    }).finally(() => {
      if (!controller.signal.aborted) setBusy('')
    })
    return () => controller.abort()
  }, [api, applyState])

  const execute = React.useCallback(async (label: string, command: Record<string, unknown>, refresh = true) => {
    try {
      const result = await invoke(label, signal => api.execute(command, signal))
      setLastResult(result)
      if (result?.ok !== true) throw new Error(hubError(result))
      if (refresh) await reload()
      return result
    } catch {
      return null
    }
  }, [api, invoke, reload])

  if (!state) {
    return h('section', { 'data-skill-graft': 'loading', style: styles.root },
      h('h2', null, 'Skill Graft'),
      h('p', { role: error ? 'alert' : undefined, style: error ? styles.danger : styles.muted }, error || 'Loading…'))
  }

  const selected = state.selectedWorkspace
  const status = successData(state.facts?.status)
  const schema = successData(state.facts?.schema)
  const inventory = successData(state.facts?.inventory) || { resident: [], adopted: [], inbox: [] }
  const snapshots = successData(state.facts?.snapshots)?.snapshots || []
  const pin = successData(state.facts?.pin)?.pin
  const planData = successData(state.facts?.plan)
  const plan = planData?.plan
  const claimed = pin?.claimState === 'claimed'
  const history = successData(state.facts?.history)?.records || []
  const items = status?.items || []
  const sessions = successData(state.facts?.sessions)?.sessions || status?.sessions || []
  const selectedSession = sessions.find((entry: any) => entry.id === selectedSessionId)
    || sessions[0]
  const isBusy = Boolean(busy)

  const setPin = () => {
    if (!selected || !snapshotId) return setError('Choose a workspace and snapshot first.')
    const skills = selectedSkills.split(',').map((entry) => entry.trim()).filter(Boolean)
    void execute('set pin', {
      kind: 'setPin', worktree: selected.path, snapshotId, selectedSkills: skills
    })
  }
  const sync = () => {
    if (!selected || !plan?.planHash) return setError('Preview a server plan first.')
    void execute('sync', {
      kind: 'sync',
      worktree: selected.path,
      planHash: plan.planHash,
      ...(selectedSession?.kind === 'attach' && selectedSession.status === 'awaiting'
        ? { sessionId: selectedSession.id }
        : {})
    })
  }
  const selectedSkillNames = () => selectedSkills.split(',').map((entry) => entry.trim()).filter(Boolean)

  const inventoryGroup = (title: string, entries: any[]) => h('div', { style: styles.card },
    h('strong', null, `${title} (${entries.length})`),
    entries.length === 0
      ? h('span', { style: styles.muted }, 'Empty')
      : h('ul', { style: styles.list }, entries.map((entry) => h('li', { key: `${title}-${entry.path}`, style: styles.row },
        h('span', null, entry.name),
        button('Read', () => {
          void execute('read skill', { kind: 'readSkill', path: entry.path }, false).then((result) => {
            if (result?.ok) setSkillDetail(result.data)
          })
        }, isBusy)))))

  return h('section', { 'data-skill-graft': 'ready', style: styles.root },
    h('div', { style: styles.heading },
      h('div', null,
        h('h2', { style: { margin: 0 } }, 'Skill Graft'),
        h('div', { style: styles.muted }, 'DSH-native settings, workspace, pinned Skills, inbox and sync')),
      button(busy ? `Working: ${busy}` : 'Refresh', () => { void reload() }, isBusy)),

    error ? h('div', { role: 'alert', 'data-skill-graft-error': '', style: { ...styles.card, ...styles.danger } }, error) : null,

    h('section', { style: styles.card, 'data-skill-graft-section': 'settings' },
      h('h3', { style: { margin: 0 } }, 'Settings & doctor'),
      h('div', { style: styles.grid },
        factLine('Data root', state.settings.dataRoot),
        factLine('Schema', schema?.status),
        factLine('Runtime', schema?.runtimeRevision),
        factLine('Writable', schema?.writable),
        factLine('Current snapshot', pin?.materializedSnapshot),
        factLine('Lock timeout', `${state.settings.lockTimeoutMs} ms`)),
      field('Workspace', h('select', {
        style: styles.input,
        value: selected?.id || '',
        disabled: isBusy,
        onChange: (event: any) => {
          void invoke('select workspace', signal => api.selectWorkspace(event.target.value, signal))
            .then(applyState).catch(() => undefined)
        }
      },
      h('option', { value: '' }, state.requiresExplicitSelection ? 'Choose explicitly…' : 'No workspace'),
      ...state.workspaces.map((workspace: any) => h('option', { key: workspace.id, value: workspace.id },
        `${workspace.title} — ${workspace.status}`)))),
      field('Automatic sync policy', h('select', {
        style: styles.input,
        value: state.settings.autoSync,
        disabled: isBusy,
        onChange: (event: any) => {
          void invoke('update settings', signal => api.updateSettings({ autoSync: event.target.value }, signal))
            .then(applyState).catch(() => undefined)
        }
      },
      h('option', { value: 'off' }, 'Off'),
      h('option', { value: 'plan' }, 'Plan only'),
      h('option', { value: 'sync' }, 'Sync already-claimed workspaces'))),
      h('div', { style: state.doctor.ok ? styles.ok : styles.danger },
        state.doctor.ok ? 'Doctor: ready' : `Doctor: ${state.doctor.issues.join(' · ')}`)),

    h('section', { style: styles.card, 'data-skill-graft-section': 'workspace' },
      h('h3', { style: { margin: 0 } }, 'Workspace registration'),
      h('div', { style: styles.row },
        h('input', { style: styles.input, value: workspacePath, placeholder: 'Existing workspace path', onChange: (e: any) => setWorkspacePath(e.target.value) }),
        h('input', { style: styles.input, value: workspaceTitle, placeholder: 'Optional title', onChange: (e: any) => setWorkspaceTitle(e.target.value) }),
        button('Register', () => {
          void invoke('register workspace', signal => api.registerWorkspace(workspacePath, workspaceTitle || undefined, signal))
            .then((next) => { applyState(next); setWorkspacePath(''); setWorkspaceTitle('') }).catch(() => undefined)
        }, isBusy || !workspacePath.trim()),
        button('Unregister selected', () => {
          if (!selected || !window.confirm('Remove only this DSH workspace registration? Files are retained.')) return
          void invoke('unregister workspace', signal => api.unregisterWorkspace(selected.id, signal))
            .then(applyState).catch(() => undefined)
        }, isBusy || !selected, styles.danger)),
      selected ? factLine('Selected path', selected.path) : h('span', { style: styles.muted }, 'No selected workspace. Multiple entries are never guessed.')),

    h('section', { style: styles.card, 'data-skill-graft-section': 'pin-plan-sync' },
      h('h3', { style: { margin: 0 } }, 'Pin, plan & sync'),
      h('div', { style: styles.grid },
        factLine('Claim', pin?.claimState),
        factLine('Requested', pin?.requestedSnapshot),
        factLine('Materialized', pin?.materializedSnapshot),
        factLine('Plan status', planData?.status),
        factLine('Executable', plan?.executable),
        factLine('Conflicts', plan?.summary?.conflict)),
      !claimed && selected
        ? h('div', { style: styles.muted }, 'This workspace is not claimed. A real attach flow must claim it; this page will not change files or register pinned Skills.')
        : null,
      field('Snapshot', h('select', {
        style: styles.input, value: snapshotId, disabled: isBusy,
        onChange: (event: any) => setSnapshotId(event.target.value)
      }, h('option', { value: '' }, 'Choose snapshot…'),
      ...snapshots.map((snapshot: any) => h('option', { key: snapshot.snapshotId, value: snapshot.snapshotId }, snapshot.snapshotId)))),
      field('Selected Skills', h('input', {
        style: styles.input, value: selectedSkills, disabled: isBusy,
        placeholder: 'comma-separated Skill names', onChange: (event: any) => setSelectedSkills(event.target.value)
      }), 'Application validates names, snapshot membership, claim and conflicts.'),
      h('div', { style: styles.row },
        button('Create snapshot', () => { void execute('create snapshot', { kind: 'createSnapshot' }) }, isBusy),
        button('Claim with attach', () => {
          if (!selected || !snapshotId || selectedSession?.kind !== 'attach') return
          void execute('claim', {
            kind: 'claimWorktree',
            worktree: selected.path,
            snapshotId,
            selectedSkills: selectedSkillNames(),
            sessionId: selectedSession.id
          })
        }, isBusy || !selected || claimed || !snapshotId
          || selectedSession?.kind !== 'attach' || selectedSession.status !== 'awaiting'),
        button('Save pin', setPin, isBusy || !selected || !claimed || !snapshotId),
        button('Preview plan', () => { if (selected) void execute('plan', { kind: 'planSync', worktree: selected.path }) }, isBusy || !selected || !claimed),
        button('Sync exact plan', sync, isBusy || !selected || plan?.executable !== true)),
      plan ? h('pre', { style: styles.pre }, JSON.stringify({ summary: plan.summary, operations: plan.operations, git: plan.git }, null, 2)) : null),

    h('section', { style: styles.card, 'data-skill-graft-section': 'sessions' },
      h('h3', { style: { margin: 0 } }, 'DSH sessions'),
      h('div', { style: styles.muted }, 'Settings starts a real top-level DSH Agent. Conversation actions use the same Application entry and require a live parent conversation.'),
      h('textarea', {
        style: { ...styles.input, minHeight: 64 },
        value: sessionIntent,
        placeholder: 'Optional attach/chat intent',
        onChange: (event: any) => setSessionIntent(event.target.value)
      }),
      h('div', { style: styles.row },
        button('Start attach', () => {
          if (!selected) return
          void execute('start attach', {
            kind: 'attach', worktree: selected.path, intent: sessionIntent,
            runner: { wait: false }
          })
        }, isBusy || !selected),
        button('Start chat', () => {
          void execute('start chat', {
            kind: 'chat', intent: sessionIntent,
            ...(selected ? { worktree: selected.path } : {}),
            runner: { wait: false }
          })
        }, isBusy),
        button('Reap / refresh', () => { void execute('reap sessions', { kind: 'reapSessions' }) }, isBusy)),
      sessions.length === 0
        ? h('span', { style: styles.muted }, 'No DSH sessions yet.')
        : h(React.Fragment, null,
            field('Selected session', h('select', {
              style: styles.input,
              value: selectedSession?.id || '',
              disabled: isBusy,
              onChange: (event: any) => setSelectedSessionId(event.target.value)
            }, ...sessions.map((entry: any) => h('option', { key: entry.id, value: entry.id },
              `${entry.kind} · ${entry.status} · ${entry.id}`)))),
            h('div', { style: styles.grid },
              factLine('Status', selectedSession?.status),
              factLine('Attempt', selectedSession?.attemptId),
              factLine('Runner', selectedSession?.runnerId),
              factLine('Resume', selectedSession?.capabilities?.canResume),
              factLine('Cancel', selectedSession?.capabilities?.canCancel)),
            h('input', {
              style: styles.input,
              value: resumeMessage,
              placeholder: 'Resume message',
              onChange: (event: any) => setResumeMessage(event.target.value)
            }),
            h('div', { style: styles.row },
              button('Resume', () => {
                if (!selectedSession) return
                void execute('resume session', {
                  kind: 'resumeSession', sessionId: selectedSession.id,
                  message: resumeMessage, runner: { wait: false }
                })
              }, isBusy || !selectedSession?.capabilities?.canResume || !resumeMessage.trim()),
              button('Cancel', () => {
                if (!selectedSession) return
                void execute('cancel session', {
                  kind: 'cancelSession', sessionId: selectedSession.id,
                  reason: 'Cancelled from the DSH Skill Graft page.'
                })
              }, isBusy || !selectedSession?.capabilities?.canCancel, styles.danger)),
            h('pre', { style: styles.pre }, JSON.stringify({
              steps: selectedSession?.steps || [],
              events: selectedSession?.events || []
            }, null, 2))),
    ),

    h('section', { style: styles.card, 'data-skill-graft-section': 'skills' },
      h('h3', { style: { margin: 0 } }, 'Skills'),
      h('div', { style: styles.row },
        h('strong', null, 'Registered in ctx.skills:'),
        h('span', null, state.registeredSkills.map((entry: any) => entry.name).join(', ') || 'none')),
      h('div', { style: styles.grid },
        inventoryGroup('Resident', inventory.resident || []),
        inventoryGroup('Adopted', inventory.adopted || []),
        inventoryGroup('Inbox files', inventory.inbox || [])),
      skillDetail ? h('pre', { style: styles.pre }, skillDetail.content) : null),

    h('section', { style: styles.card, 'data-skill-graft-section': 'inbox' },
      h('h3', { style: { margin: 0 } }, `Inbox / updates (${items.length})`),
      h('textarea', {
        style: { ...styles.input, minHeight: 80 }, value: inboxPayload,
        placeholder: 'Optional ingest payload', onChange: (event: any) => setInboxPayload(event.target.value)
      }),
      h('input', {
        style: styles.input, value: inboxGameRepo,
        placeholder: 'Optional isolated game repo', onChange: (event: any) => setInboxGameRepo(event.target.value)
      }),
      h('div', { style: styles.row },
        button('Ingest dry-run', () => { void execute('ingest dry-run', { kind: 'ingest', payload: inboxPayload, ...(inboxGameRepo.trim() ? { gameRepo: inboxGameRepo.trim() } : {}), dryRun: true }) }, isBusy || !inboxPayload.trim()),
        button('Ingest', () => { void execute('ingest', { kind: 'ingest', payload: inboxPayload, ...(inboxGameRepo.trim() ? { gameRepo: inboxGameRepo.trim() } : {}) }) }, isBusy || !inboxPayload.trim()),
        h('input', { style: styles.input, value: mergeTarget, placeholder: 'Merge target', onChange: (e: any) => setMergeTarget(e.target.value) })),
      items.length === 0 ? h('span', { style: styles.muted }, 'Inbox is empty.') : h('ul', { style: styles.list }, items.map((item: any) => h('li', { key: item.id, style: styles.card },
        h('div', { style: styles.row }, h('strong', null, item.name), h('span', { style: styles.muted }, `${item.status} · ${item.unit}`)),
        h('div', { style: styles.row },
          button('Adopt', () => { void execute('adopt', { kind: 'decide', id: item.id, action: 'adopt' }) }, isBusy),
          button('Merge', () => { void execute('merge', { kind: 'decide', id: item.id, action: 'merge', mergeTarget }) }, isBusy || !mergeTarget.trim()),
          button('Reject', () => { void execute('reject', { kind: 'decide', id: item.id, action: 'reject' }) }, isBusy, styles.danger))))),

    h('section', { style: styles.card, 'data-skill-graft-section': 'history' },
      h('h3', { style: { margin: 0 } }, `History (${history.length})`),
      history.length === 0 ? h('span', { style: styles.muted }, 'No history yet.') : h('ul', { style: styles.list }, history.slice(0, 20).map((entry: any) => h('li', { key: entry.id },
        h('strong', null, entry.type), h('span', { style: styles.muted }, ` ${entry.at || ''} ${entry.summary || ''}`))))),

    lastResult ? h('details', null, h('summary', null, 'Last Application result'), h('pre', { style: styles.pre }, JSON.stringify(lastResult, null, 2))) : null)
  )
}

function SkillGraftConversationAction({ api, sessionId }: { api: SkillGraftApi; sessionId?: string }) {
  const [label, setLabel] = React.useState('Skill Graft attach')
  const controller = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => controller.current?.abort(), [])
  return h('button', {
    type: 'button',
    title: label,
    style: styles.button,
    disabled: !sessionId || label === 'Starting…',
    onClick: async () => {
      if (!sessionId) return
      controller.current?.abort()
      controller.current = new AbortController()
      const signal = controller.current.signal
      setLabel('Starting…')
      try {
        const described = await api.describe(signal)
        const workspace = described?.ok === true ? described.value?.selectedWorkspace : undefined
        if (!workspace?.path) throw new Error('Select a Skill Graft workspace in Settings first.')
        const result = await api.executeFromSession(sessionId, {
          kind: 'attach',
          worktree: workspace.path,
          intent: 'Prepare this workspace for a trusted Skill Graft attach.',
          runner: { wait: false }
        }, signal)
        if (result?.ok !== true || result.value?.ok !== true) throw new Error(rpcError(result))
        setLabel(`Attach ${result.value.data?.session?.status || 'started'}`)
      } catch (error) {
        if (!signal.aborted) setLabel(error instanceof Error ? error.message : String(error))
      }
    }
  }, 'Skill Graft')
}

export function apply(ctx: any): void {
  const call = (endpoint: string, payload: unknown, signal?: AbortSignal) => (
    ctx.connection.rpc.call('/skill-graft', endpoint, payload, signal)
  )
  const api: SkillGraftApi = Object.freeze({
    execute: (command, signal) => call('execute', { command }, signal),
    executeFromSession: (parentSessionId, command, signal) => (
      call('execute-from-session', { parentSessionId, command }, signal)
    ),
    describe: signal => call('describe', {}, signal),
    refresh: signal => call('refresh', {}, signal),
    updateSettings: (patch, signal) => call('update-settings', { patch }, signal),
    selectWorkspace: (workspaceId, signal) => call('select-workspace', { workspaceId }, signal),
    registerWorkspace: (path, title, signal) => call('register-workspace', { path, ...(title ? { title } : {}) }, signal),
    unregisterWorkspace: (workspaceId, signal) => call('unregister-workspace', { workspaceId }, signal)
  })
  ctx.provide('skillGraft', api)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'skill-graft',
    order: 60,
    label: () => 'Skill Graft'
  }, () => h(SkillGraftPanel, { api })))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'skill-graft-attach',
    order: 70,
    label: () => 'Skill Graft'
  }, (props: any) => h(SkillGraftConversationAction, { ...props, api })))
}
