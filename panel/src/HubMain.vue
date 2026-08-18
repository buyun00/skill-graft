<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { api, type HubState, type InboxItem, type SkillNode, type WorktreeInfo } from './api'

const page = ref('sessions')
const loading = ref(false)
const launching = ref(false)
const error = ref('')
const toast = ref('')
const state = ref<HubState | null>(null)
const history = ref<Array<Record<string, unknown>>>([])
const sessions = ref<Array<Record<string, unknown>>>([])
const worktrees = ref<WorktreeInfo[]>([])
const scanRoots = ref<string[]>([])
const preview = ref('')
const previewTitle = ref('')
const showPreview = ref(false)
const mergeTarget = ref('skills/ozdqp-development/references/testing-and-verification.md')
const launchKind = ref<'chat' | 'edit' | 'attach'>('chat')
const launchPath = ref('skills/ozdqp-development')
const launchWorktree = ref('')
const launchIntent = ref('')
const followUp = ref('')
const selectedRun = ref('')
const liveLogs = ref<Record<string, string>>({})
const liveStatus = ref<Record<string, string>>({})
const eventSources = new Map<string, EventSource>()
const resuming = ref(false)

const navItems = [
  { key: 'sessions', label: '运行' },
  { key: 'worktrees', label: '工作区' },
  { key: 'structure', label: 'Skills' },
  { key: 'inbox', label: '待审' },
  { key: 'history', label: '历史' }
]

const queuedItems = computed(() => (state.value?.items ?? []).filter((item) => ['queued', 'proposed'].includes(item.status)))
const runningCount = computed(() => sessions.value.filter((session) => sessionStatus(session) === 'running').length)
const orderedSessions = computed(() => [...sessions.value].reverse())
const currentSession = computed(() => orderedSessions.value.find((session) => String(session.id) === selectedRun.value) || orderedSessions.value[0] || null)
const canContinue = computed(() => {
  const session = currentSession.value
  if (!session) return false
  const status = sessionStatus(session)
  return Boolean(session.codexSessionId) && status !== 'running' && status !== 'failed'
})
const allSkills = computed(() => (state.value ? [...state.value.resident, ...state.value.adopted, ...state.value.inbox] : []))

const pageMeta: Record<string, { title: string; subtitle: string }> = {
  sessions: { title: '运行', subtitle: '在面板内部执行 Codex。一轮结束后可以继续同一条会话' },
  worktrees: { title: '工作区', subtitle: '按目录名和最近改动排列，一键换成中心仓体系' },
  structure: { title: 'Skills', subtitle: '常驻、已采用和 inbox 原料' },
  inbox: { title: '待审', subtitle: '别人推上来的官方 Skill，先看再决定' },
  history: { title: '历史', subtitle: '入队、拍板和执行记录' }
}

function notify(text: string) {
  toast.value = text
  window.setTimeout(() => { if (toast.value === text) toast.value = '' }, 2200)
}

function formatChangedAt(ms: number, iso: string) {
  if (!ms) return '时间未知'
  const delta = Date.now() - ms
  const minutes = Math.floor(delta / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return iso ? iso.replace('T', ' ').slice(0, 16) : '时间未知'
}

function sessionStatus(session: Record<string, unknown>) {
  return liveStatus.value[String(session.id)] || String(session.status || '')
}

function sessionLog(session: Record<string, unknown>) {
  const id = String(session.id || '')
  return liveLogs.value[id] || String(session.logTail || session.lastMessage || '')
}

function statusClass(status: string) {
  if (status === 'adopted' || status === 'completed' || status === 'waiting') return 'badge-success'
  if (status === 'rejected' || status === 'failed') return 'badge-error'
  if (status === 'proposed' || status === 'running') return 'badge-warning'
  if (status === 'merged-into-3skill') return 'badge-info'
  return 'badge-ghost'
}

function statusLabel(status: string) {
  if (status === 'waiting') return '可续聊'
  if (status === 'running') return '执行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  return status
}

function watchSession(id: string) {
  if (!id || eventSources.has(id)) return
  const source = new EventSource(`/api/codex/session/stream?id=${encodeURIComponent(id)}`)
  eventSources.set(id, source)
  source.addEventListener('log', (event) => {
    const data = JSON.parse((event as MessageEvent).data || '{}')
    liveLogs.value = { ...liveLogs.value, [id]: data.text || '' }
    void nextTick()
  })
  source.addEventListener('status', (event) => {
    const data = JSON.parse((event as MessageEvent).data || '{}')
    liveStatus.value = { ...liveStatus.value, [id]: data.status || '' }
    if (data.codexSessionId) {
      sessions.value = sessions.value.map((item) => item.id === id ? { ...item, ...data } : item)
    }
    if (data.status && data.status !== 'running') {
      source.close()
      eventSources.delete(id)
      void refresh(true)
    }
  })
  source.onerror = () => {
    if (liveStatus.value[id] && liveStatus.value[id] !== 'running') {
      source.close()
      eventSources.delete(id)
    }
  }
}

async function refresh(silent = false) {
  if (!silent) loading.value = true
  error.value = ''
  try {
    const [nextState, nextHistory, nextSessions, nextWorktrees] = await Promise.all([
      api.state(),
      api.history(),
      api.sessions(),
      api.worktrees()
    ])
    state.value = nextState
    history.value = nextHistory.records
    sessions.value = nextSessions.sessions
    worktrees.value = nextWorktrees.worktrees
    scanRoots.value = nextWorktrees.scanRoots || []
    if (!launchWorktree.value && nextWorktrees.worktrees[0]) launchWorktree.value = nextWorktrees.worktrees[0].path
    if (!selectedRun.value && nextSessions.sessions.length) {
      selectedRun.value = String(nextSessions.sessions[nextSessions.sessions.length - 1].id)
    }
    for (const session of nextSessions.sessions) {
      if (session.status === 'running') watchSession(String(session.id))
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function openSkill(node: SkillNode) {
  const result = await api.skill(node.path)
  previewTitle.value = node.path
  preview.value = result.content
  showPreview.value = true
}

async function openInbox(item: InboxItem) {
  const path = item.inboxPath ? `${item.inboxPath}/SKILL.md` : ''
  if (!path) return
  const result = await api.skill(path)
  previewTitle.value = path
  preview.value = result.content
  showPreview.value = true
}

async function decide(item: InboxItem, action: 'adopt' | 'merge' | 'reject') {
  await api.decide({
    id: item.id,
    action,
    mergeTarget: action === 'merge' ? mergeTarget.value : undefined
  })
  await refresh(true)
  notify(action === 'adopt' ? '已采用' : action === 'merge' ? '已并入' : '已拒绝')
}

function openLaunch(kind: 'chat' | 'edit' | 'attach' = 'chat', preset?: { path?: string; worktree?: string; intent?: string }) {
  launchKind.value = kind
  if (preset?.path) launchPath.value = preset.path
  if (preset?.worktree) launchWorktree.value = preset.worktree
  if (preset?.intent) launchIntent.value = preset.intent
  page.value = 'sessions'
}

async function launchCodex() {
  launching.value = true
  try {
    let started: Record<string, unknown>
    if (launchKind.value === 'edit') {
      started = await api.startCodex({ kind: 'edit', path: launchPath.value, intent: launchIntent.value })
    } else if (launchKind.value === 'attach') {
      started = await api.startCodex({ kind: 'attach', worktree: launchWorktree.value, intent: launchIntent.value })
    } else {
      started = await api.startCodex({ kind: 'chat', intent: launchIntent.value })
    }
    const id = String(started.id || '')
    sessions.value = [...sessions.value, { ...started, status: started.status || 'running', logTail: '已启动，等待 Codex 输出…' }]
    selectedRun.value = id
    if (id) watchSession(id)
    page.value = 'sessions'
    launchIntent.value = ''
    notify('已开始执行')
  } catch (err) {
    notify(err instanceof Error ? err.message : String(err))
  } finally {
    launching.value = false
  }
}

async function continueCodex() {
  const session = currentSession.value
  const id = session ? String(session.id || '') : ''
  if (!id || !followUp.value.trim()) return
  resuming.value = true
  try {
    const started = await api.resumeCodex({ id, message: followUp.value.trim() })
    sessions.value = sessions.value.map((item) => item.id === id ? { ...item, ...started, status: 'running' } : item)
    liveStatus.value = { ...liveStatus.value, [id]: 'running' }
    watchSession(id)
    followUp.value = ''
    notify('已继续同一条会话')
  } catch (err) {
    notify(err instanceof Error ? err.message : String(err))
  } finally {
    resuming.value = false
  }
}

onMounted(() => { void refresh() })
onUnmounted(() => {
  for (const source of eventSources.values()) source.close()
  eventSources.clear()
})
</script>

<template>
  <div class="relative min-h-screen">
    <div class="ambient"><span class="a" /><span class="b" /></div>

    <div v-if="toast" class="toast toast-top toast-end z-50">
      <div class="alert alert-info glass">{{ toast }}</div>
    </div>

    <div class="relative z-10 flex min-h-screen">
      <aside class="w-60 shrink-0 border-r border-white/10 p-4 flex flex-col gap-5">
        <div>
          <div class="text-lg font-bold tracking-wide">Skill Hub</div>
          <div class="text-xs opacity-60">本地中心仓</div>
        </div>
        <ul class="menu gap-1 p-0">
          <li v-for="item in navItems" :key="item.key">
            <button :class="{ 'menu-active': page === item.key }" @click="page = item.key">
              <span>{{ item.label }}</span>
              <span v-if="item.key === 'inbox' && queuedItems.length" class="badge badge-primary badge-sm">{{ queuedItems.length }}</span>
              <span v-else-if="item.key === 'sessions' && runningCount" class="badge badge-secondary badge-sm">{{ runningCount }}</span>
            </button>
          </li>
        </ul>
        <button class="btn btn-primary mt-auto" @click="openLaunch('chat')">新任务</button>
      </aside>

      <main class="min-w-0 flex-1 p-6">
        <div class="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 class="text-2xl font-semibold">{{ pageMeta[page].title }}</h1>
            <p class="mt-1 text-sm opacity-60">{{ pageMeta[page].subtitle }}</p>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-ghost btn-sm" @click="refresh()">刷新</button>
            <button v-if="page === 'inbox'" class="btn btn-ghost btn-sm" @click="api.analyze()">重新分析</button>
          </div>
        </div>

        <div v-if="error" class="alert alert-error glass mb-4">{{ error }}</div>

        <template v-if="state">
          <div v-if="page === 'sessions'" class="space-y-4">
            <div class="grid min-h-[28rem] grid-cols-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
              <div class="card glass">
                <div class="card-body p-3">
                  <h2 class="card-title text-sm">任务</h2>
                  <p v-if="!orderedSessions.length" class="py-8 text-center text-sm opacity-60">还没有任务，用下方输入框开始</p>
                  <button
                    v-for="session in orderedSessions"
                    :key="String(session.id)"
                    class="rounded-xl p-3 text-left transition hover:bg-white/5"
                    :class="{ 'bg-white/10': currentSession && currentSession.id === session.id }"
                    @click="selectedRun = String(session.id)"
                  >
                    <div class="font-medium">{{ session.kind }}</div>
                    <div class="mt-1 text-xs opacity-60">{{ session.worktree || session.path || '中心仓' }}</div>
                    <div class="badge badge-sm mt-2" :class="statusClass(sessionStatus(session))">{{ statusLabel(sessionStatus(session)) }}</div>
                  </button>
                </div>
              </div>
              <div class="card glass">
                <div class="card-body">
                  <h2 class="card-title text-base">{{ currentSession ? `${currentSession.kind} · ${statusLabel(sessionStatus(currentSession))}` : '实时输出' }}</h2>
                  <pre class="min-h-80 overflow-auto rounded-xl bg-base-300/40 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">{{ currentSession ? (sessionLog(currentSession) || '等待输出…') : '选一个任务，或在下方描述你要做的事。' }}</pre>
                  <div v-if="canContinue" class="space-y-3 border-t border-white/10 pt-3">
                    <p class="text-sm opacity-70">这一轮已经结束，但会话还在。继续说下一句即可，不必再开新任务。</p>
                    <textarea v-model="followUp" class="textarea textarea-bordered min-h-20" placeholder="继续对这条 Codex 会话说话" />
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-xs opacity-60">沿用同一 session id，不会另开一条对话。</span>
                      <button class="btn btn-primary" :class="{ loading: resuming }" :disabled="resuming || !followUp.trim()" @click="continueCodex">继续</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="card glass">
              <div class="card-body gap-3">
                <h2 class="card-title text-base">新开一条任务</h2>
                <div class="join">
                  <button class="btn join-item btn-sm" :class="{ 'btn-primary': launchKind === 'chat' }" @click="launchKind = 'chat'">对话</button>
                  <button class="btn join-item btn-sm" :class="{ 'btn-primary': launchKind === 'edit' }" @click="launchKind = 'edit'">改 Skill</button>
                  <button class="btn join-item btn-sm" :class="{ 'btn-primary': launchKind === 'attach' }" @click="launchKind = 'attach'">处理工作区</button>
                </div>
                <select v-if="launchKind === 'edit'" v-model="launchPath" class="select select-bordered w-full">
                  <option v-for="node in allSkills" :key="node.path" :value="node.path">{{ node.name }} ({{ node.path }})</option>
                </select>
                <select v-if="launchKind === 'attach'" v-model="launchWorktree" class="select select-bordered w-full">
                  <option v-for="tree in worktrees" :key="tree.path" :value="tree.path">{{ tree.name }} · {{ tree.path }}</option>
                </select>
                <textarea v-model="launchIntent" class="textarea textarea-bordered min-h-24" placeholder="描述你要 Codex 做的事" />
                <div class="flex items-center justify-between gap-3">
                  <span class="text-xs opacity-60">内部执行，不弹窗。结果在上方实时刷新。</span>
                  <button class="btn btn-primary" :class="{ loading: launching }" :disabled="launching" @click="launchCodex">运行</button>
                </div>
              </div>
            </div>
          </div>

          <div v-else-if="page === 'worktrees'" class="space-y-4">
            <div class="alert glass">扫描 {{ scanRoots.join('、') || '未配置' }} · 共 {{ worktrees.length }} 个工作区 · 按最近本地改动排序</div>
            <div v-for="tree in worktrees" :key="tree.path" class="card glass">
              <div class="card-body">
                <div class="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 class="card-title">{{ tree.name }}</h3>
                    <p class="text-sm opacity-70">{{ tree.path }}</p>
                    <div class="mt-2 flex flex-wrap gap-2">
                      <span class="badge" :class="tree.attached ? 'badge-success' : 'badge-warning'">{{ tree.attached ? '已用中心仓' : '仍用分支自带' }}</span>
                      <span v-if="tree.doNotAuto" class="badge badge-ghost">勿自动</span>
                      <span v-if="tree.ephemeral" class="badge badge-info">临时</span>
                      <span v-if="tree.locked" class="badge">locked</span>
                      <span v-if="tree.prunable" class="badge badge-error">prunable</span>
                      <span class="badge badge-ghost">{{ formatChangedAt(tree.changedAtMs, tree.changedAt) }}</span>
                    </div>
                    <p class="mt-2 text-xs opacity-60">{{ tree.branch }} · {{ tree.cloneRoot }}</p>
                    <p class="text-xs opacity-60">
                      {{ tree.officialPresent ? '官方 Skill 树还在磁盘' : '官方 Skill 树已拿走' }}
                      ·
                      {{ tree.overrideLinked ? 'override 已接通' : 'override 未接通' }}
                    </p>
                  </div>
                  <button class="btn btn-primary" @click="openLaunch('attach', { worktree: tree.path, intent: tree.attached ? '检查并修复这棵树与中心仓的挂接' : '剥官方 Skill，改挂中心仓' })">
                    {{ tree.attached ? '检查' : '改用本地 Skill' }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div v-else-if="page === 'structure'" class="space-y-4">
            <div v-for="group in [
              { title: '常驻', nodes: state.resident },
              { title: '已采用', nodes: state.adopted },
              { title: 'Inbox', nodes: state.inbox }
            ]" :key="group.title" class="card glass">
              <div class="card-body">
                <h2 class="card-title">{{ group.title }}</h2>
                <p v-if="!group.nodes.length" class="py-6 text-center text-sm opacity-60">这里还是空的</p>
                <div v-for="node in group.nodes" :key="node.path" class="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 py-3">
                  <div>
                    <div class="font-medium">{{ node.name }}</div>
                    <div class="text-xs opacity-60">{{ node.path }}</div>
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="badge" :class="node.attached ? 'badge-success' : 'badge-ghost'">{{ node.attached ? '已挂接' : '仅中心仓' }}</span>
                    <button class="btn btn-ghost btn-sm" @click="openSkill(node)">预览</button>
                    <button class="btn btn-primary btn-sm" @click="openLaunch('edit', { path: node.path, intent: '按客户端需要改这个 Skill' })">用 Codex 改</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-else-if="page === 'inbox'" class="space-y-4">
            <div class="card glass">
              <div class="card-body">
                <h2 class="card-title text-base">并进 3 Skill 时的目标文件</h2>
                <input v-model="mergeTarget" class="input input-bordered w-full" />
              </div>
            </div>
            <div v-if="!queuedItems.length" class="empty-state py-10 text-center opacity-60">没有待审项。fetch/pull 官方 Skill 后会到这里。</div>
            <div v-for="item in queuedItems" :key="item.id" class="card glass">
              <div class="card-body">
                <div class="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 class="card-title">{{ item.name }}</h3>
                    <div class="badge mt-1" :class="statusClass(item.status)">{{ item.status }}</div>
                    <p class="mt-2 text-sm opacity-70">{{ item.unit }} · {{ item.sourceRef }}</p>
                    <p v-if="item.suggestion?.reason" class="text-xs opacity-60">建议：{{ item.suggestion.action }} / {{ item.suggestion.reason }}</p>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button class="btn btn-ghost btn-sm" @click="openInbox(item)">预览</button>
                    <button class="btn btn-primary btn-sm" @click="openLaunch('edit', { path: item.inboxPath || '', intent: '按客户端改这条 inbox Skill' })">用 Codex 改</button>
                    <button class="btn btn-success btn-sm" @click="decide(item, 'adopt')">采用</button>
                    <button class="btn btn-ghost btn-sm" @click="decide(item, 'merge')">并进</button>
                    <button class="btn btn-error btn-sm" @click="decide(item, 'reject')">拒绝</button>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="state.items.length" class="card glass">
              <div class="card-body overflow-x-auto">
                <h2 class="card-title">全部记录</h2>
                <table class="table table-sm">
                  <thead><tr><th>名称</th><th>状态</th><th>来源</th></tr></thead>
                  <tbody>
                    <tr v-for="item in state.items" :key="item.id">
                      <td>{{ item.name }}</td>
                      <td>{{ item.status }}</td>
                      <td>{{ item.sourceRef }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div v-else class="space-y-4">
            <div v-if="!history.length" class="py-10 text-center opacity-60">暂无历史</div>
            <div v-for="(record, index) in history" :key="index" class="card glass">
              <div class="card-body">
                <pre class="overflow-auto font-mono text-xs whitespace-pre-wrap">{{ JSON.stringify(record, null, 2) }}</pre>
              </div>
            </div>
          </div>
        </template>
        <div v-else-if="loading" class="py-16 text-center opacity-60">正在载入中心仓…</div>
      </main>
    </div>

    <dialog class="modal" :class="{ 'modal-open': showPreview }">
      <div class="modal-box glass max-w-3xl">
        <h3 class="text-lg font-bold">{{ previewTitle }}</h3>
        <pre class="mt-4 max-h-[70vh] overflow-auto font-mono text-xs whitespace-pre-wrap">{{ preview }}</pre>
        <div class="modal-action">
          <button class="btn" @click="showPreview = false">关闭</button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop" @click="showPreview = false"><button>close</button></form>
    </dialog>
  </div>
</template>
