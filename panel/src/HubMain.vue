<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { NSelect, useMessage, type SelectOption } from 'naive-ui'
import { api, type HubState, type InboxItem, type SkillNode, type WorktreeInfo } from './api'

const message = useMessage()
const page = ref('sessions')
const loading = ref(false)
const launching = ref(false)
const error = ref('')
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
const selectedRun = ref('')
const liveLogs = ref<Record<string, string>>({})
const liveStatus = ref<Record<string, string>>({})
const liveBoxes = new Map<string, HTMLElement>()
const eventSources = new Map<string, EventSource>()

const nav = [
  { key: 'sessions', label: '运行' },
  { key: 'worktrees', label: '工作区' },
  { key: 'structure', label: 'Skills' },
  { key: 'inbox', label: '待审' },
  { key: 'history', label: '历史' }
]

const queuedItems = computed(() => (state.value?.items ?? []).filter((item) => ['queued', 'proposed'].includes(item.status)))
const runningCount = computed(() => sessions.value.filter((session) => (liveStatus.value[String(session.id)] || session.status) === 'running').length)
const orderedSessions = computed(() => [...sessions.value].reverse())
const currentSession = computed(() => orderedSessions.value.find((session) => String(session.id) === selectedRun.value) || orderedSessions.value[0] || null)
const allSkills = computed(() => state.value ? [...state.value.resident, ...state.value.adopted, ...state.value.inbox] : [])

const skillOptions = computed<SelectOption[]>(() =>
  allSkills.value.map((node) => ({ label: `${node.name}  (${node.path})`, value: node.path }))
)
const worktreeOptions = computed<SelectOption[]>(() =>
  worktrees.value.map((tree) => ({ label: `${tree.name}  ·  ${tree.path}`, value: tree.path }))
)

const pageCopy: Record<string, { title: string; sub: string }> = {
  sessions: { title: '运行', sub: '在面板内部执行 Codex，日志实时出现在这里' },
  worktrees: { title: '工作区', sub: '按目录名和最近改动排列，一键换成中心仓体系' },
  structure: { title: 'Skills', sub: '常驻、已采用和 inbox 原料都在这里' },
  inbox: { title: '待审', sub: '别人推上来的官方 Skill，先看再决定' },
  history: { title: '历史', sub: '入队、拍板和执行记录' }
}

function formatChangedAt(ms: number, iso: string) {
  if (!ms) return '时间未知'
  const delta = Date.now() - ms
  const minutes = Math.floor(delta / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(hoursOf(minutes))
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return iso ? iso.replace('T', ' ').slice(0, 16) : '时间未知'
}

function hoursOf(minutes: number) {
  return minutes / 60
}

function sessionStatus(session: Record<string, unknown>) {
  return liveStatus.value[String(session.id)] || String(session.status || '')
}

function sessionLog(session: Record<string, unknown>) {
  const id = String(session.id || '')
  return liveLogs.value[id] || String(session.logTail || session.lastMessage || '')
}

function bindLiveBox(id: string, el: unknown) {
  if (el instanceof HTMLElement) liveBoxes.set(id, el)
}

function scrollLive(id: string) {
  const box = liveBoxes.get(id)
  if (box) box.scrollTop = box.scrollHeight
}

function watchSession(id: string) {
  if (!id || eventSources.has(id)) return
  const source = new EventSource(`/api/codex/session/stream?id=${encodeURIComponent(id)}`)
  eventSources.set(id, source)
  source.addEventListener('log', (event) => {
    const data = JSON.parse((event as MessageEvent).data || '{}')
    liveLogs.value = { ...liveLogs.value, [id]: data.text || '' }
    void nextTick(() => scrollLive(id))
  })
  source.addEventListener('status', (event) => {
    const data = JSON.parse((event as MessageEvent).data || '{}')
    liveStatus.value = { ...liveStatus.value, [id]: data.status || '' }
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
  message.success(action === 'adopt' ? '已采用' : action === 'merge' ? '已并入' : '已拒绝')
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
    message.success('已开始执行')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    launching.value = false
  }
}

onMounted(() => { void refresh() })
onUnmounted(() => {
  for (const source of eventSources.values()) source.close()
  eventSources.clear()
})
</script>

<template>
  <div class="app-shell">
    <aside class="side">
      <div class="brand">
        <div class="brand-mark" />
        <h1>Skill Hub</h1>
        <p>本地中心仓</p>
      </div>
      <nav class="nav">
        <button v-for="item in nav" :key="item.key" class="nav-btn" :class="{ active: page === item.key }" @click="page = item.key">
          <span>{{ item.label }}</span>
          <span v-if="item.key === 'inbox' && queuedItems.length" class="badge">{{ queuedItems.length }}</span>
          <span v-else-if="item.key === 'sessions' && runningCount" class="badge">{{ runningCount }}</span>
        </button>
      </nav>
      <div class="side-cta">
        <button class="primary-btn" style="width:100%" @click="openLaunch('chat')">新任务</button>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <h2>{{ pageCopy[page].title }}</h2>
          <p class="sub">{{ pageCopy[page].sub }}</p>
        </div>
        <div class="actions">
          <button class="ghost-btn" @click="refresh()">刷新</button>
          <button v-if="page === 'inbox'" class="ghost-btn" @click="api.analyze()">重新分析</button>
        </div>
      </header>
      <p v-if="error" class="error-banner">{{ error }}</p>

      <section class="content">
        <template v-if="state">
          <div v-if="page === 'sessions'">
            <div class="run-layout">
              <div class="panel run-list">
                <div class="kicker">任务</div>
                <button
                  v-for="session in orderedSessions"
                  :key="String(session.id)"
                  class="run-item"
                  :class="{ active: currentSession && currentSession.id === session.id }"
                  @click="selectedRun = String(session.id)"
                >
                  <div class="title">{{ session.kind }}</div>
                  <div class="meta">{{ sessionStatus(session) }} · {{ session.worktree || session.path || '中心仓' }}</div>
                </button>
                <div v-if="!orderedSessions.length" class="empty">还没有任务。用下面的输入框直接开始。</div>
              </div>
              <div class="panel run-stage">
                <template v-if="currentSession">
                  <div class="kicker">实时输出</div>
                  <div class="title" style="margin-bottom:10px">{{ currentSession.kind }} · {{ sessionStatus(currentSession) }}</div>
                  <pre class="live-log" :ref="(el) => bindLiveBox(String(currentSession.id), el)">{{ sessionLog(currentSession) || '等待输出…' }}</pre>
                </template>
                <div v-else class="empty">选一个任务，或在下方描述你要做的事。</div>
              </div>
            </div>

            <div class="composer">
              <div class="mode-row">
                <button class="mode" :class="{ on: launchKind === 'chat' }" @click="launchKind = 'chat'">对话</button>
                <button class="mode" :class="{ on: launchKind === 'edit' }" @click="launchKind = 'edit'">改 Skill</button>
                <button class="mode" :class="{ on: launchKind === 'attach' }" @click="launchKind = 'attach'">处理工作区</button>
              </div>
              <n-select v-if="launchKind === 'edit'" v-model:value="launchPath" :options="skillOptions" filterable style="margin-bottom:10px" />
              <n-select v-if="launchKind === 'attach'" v-model:value="launchWorktree" :options="worktreeOptions" filterable style="margin-bottom:10px" />
              <textarea v-model="launchIntent" placeholder="描述你要 Codex 做的事，例如：检查这棵树有没有挂上中心仓" />
              <div class="composer-foot">
                <span class="meta">内部执行，不弹窗。结果在上方实时刷新。</span>
                <button class="primary-btn" :disabled="launching" @click="launchCodex">{{ launching ? '启动中' : '运行' }}</button>
              </div>
            </div>
          </div>

          <div v-else-if="page === 'worktrees'">
            <div class="panel" style="margin-bottom:14px">
              <div class="kicker">扫描范围</div>
              <div class="meta">{{ scanRoots.join('、') || '未配置' }} · {{ worktrees.length }} 个工作区 · 按最近本地改动排序</div>
            </div>
            <div class="list">
              <article v-for="tree in worktrees" :key="tree.path" class="row-card">
                <div>
                  <div class="title">{{ tree.name }}</div>
                  <div class="chips">
                    <span class="chip" :class="tree.attached ? 'ok' : 'warn'">{{ tree.attached ? '已用中心仓' : '仍用分支自带' }}</span>
                    <span v-if="tree.doNotAuto" class="chip">勿自动</span>
                    <span v-if="tree.ephemeral" class="chip info">临时</span>
                    <span v-if="tree.locked" class="chip">locked</span>
                    <span v-if="tree.prunable" class="chip bad">prunable</span>
                    <span class="chip">{{ formatChangedAt(tree.changedAtMs, tree.changedAt) }}</span>
                  </div>
                  <div class="meta">{{ tree.path }}</div>
                  <div class="meta">{{ tree.branch }} · {{ tree.cloneRoot }}</div>
                  <div class="meta">
                    {{ tree.officialPresent ? '官方 Skill 树还在磁盘' : '官方 Skill 树已拿走' }}
                    ·
                    {{ tree.overrideLinked ? 'override 已接通' : 'override 未接通' }}
                  </div>
                </div>
                <div class="actions">
                  <button class="primary-btn" @click="openLaunch('attach', { worktree: tree.path, intent: tree.attached ? '检查并修复这棵树与中心仓的挂接' : '剥官方 Skill，改挂中心仓' })">
                    {{ tree.attached ? '检查' : '改用本地 Skill' }}
                  </button>
                </div>
              </article>
            </div>
          </div>

          <div v-else-if="page === 'structure'">
            <div v-for="group in [
              { title: '常驻', nodes: state.resident },
              { title: '已采用', nodes: state.adopted },
              { title: 'Inbox', nodes: state.inbox }
            ]" :key="group.title" class="list" style="margin-bottom:18px">
              <div class="kicker">{{ group.title }}</div>
              <article v-for="node in group.nodes" :key="node.path" class="row-card">
                <div>
                  <div class="title">{{ node.name }}</div>
                  <div class="meta">{{ node.path }}</div>
                </div>
                <div class="actions">
                  <span class="chip" :class="node.attached ? 'ok' : ''">{{ node.attached ? '已挂接' : '仅中心仓' }}</span>
                  <button class="ghost-btn" @click="openSkill(node)">预览</button>
                  <button class="primary-btn" @click="openLaunch('edit', { path: node.path, intent: '按客户端需要改这个 Skill' })">用 Codex 改</button>
                </div>
              </article>
              <div v-if="group.nodes.length === 0" class="empty">这里还是空的</div>
            </div>
          </div>

          <div v-else-if="page === 'inbox'">
            <div class="panel" style="margin-bottom:14px">
              <div class="kicker">并进 3 Skill 时的目标文件</div>
              <input v-model="mergeTarget" class="ghost-btn" style="width:100%;margin-top:8px;text-align:left" />
            </div>
            <article v-for="item in queuedItems" :key="item.id" class="row-card">
              <div>
                <div class="title">{{ item.name }}</div>
                <div class="chips"><span class="chip info">{{ item.status }}</span></div>
                <div class="meta">{{ item.unit }} · {{ item.sourceRef }}</div>
                <div v-if="item.suggestion?.reason" class="meta">建议：{{ item.suggestion.action }} / {{ item.suggestion.reason }}</div>
              </div>
              <div class="actions">
                <button class="ghost-btn" @click="openInbox(item)">预览</button>
                <button class="primary-btn" @click="openLaunch('edit', { path: item.inboxPath || '', intent: '按客户端改这条 inbox Skill' })">用 Codex 改</button>
                <button class="ok-btn ghost-btn" @click="decide(item, 'adopt')">采用</button>
                <button class="ghost-btn" @click="decide(item, 'merge')">并进</button>
                <button class="danger-btn ghost-btn" @click="decide(item, 'reject')">拒绝</button>
              </div>
            </article>
            <div v-if="queuedItems.length === 0" class="empty">没有待审项。fetch/pull 官方 Skill 后会到这里。</div>
            <div v-if="state.items.length" class="panel" style="margin-top:16px">
              <div class="kicker">全部记录</div>
              <div v-for="item in state.items" :key="item.id" class="meta" style="margin-top:8px">{{ item.name }} · {{ item.status }} · {{ item.sourceRef }}</div>
            </div>
          </div>

          <div v-else>
            <article v-for="(record, index) in history" :key="index" class="panel" style="margin-bottom:10px">
              <pre class="live-log" style="height:auto;min-height:0;max-height:280px">{{ JSON.stringify(record, null, 2) }}</pre>
            </article>
            <div v-if="history.length === 0" class="empty">暂无历史</div>
          </div>
        </template>
        <div v-else-if="loading" class="empty">正在载入中心仓…</div>
      </section>
    </main>
  </div>

  <aside v-if="showPreview" class="preview-pane">
    <div class="actions" style="margin-bottom:12px">
      <div class="title">{{ previewTitle }}</div>
      <button class="text-btn" @click="showPreview = false">关闭</button>
    </div>
    <pre class="live-log" style="height:calc(100vh - 90px)">{{ preview }}</pre>
  </aside>
</template>
