<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import InputText from 'primevue/inputtext'
import Tag from 'primevue/tag'
import Badge from 'primevue/badge'
import Drawer from 'primevue/drawer'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Splitter from 'primevue/splitter'
import SplitterPanel from 'primevue/splitterpanel'
import ScrollPanel from 'primevue/scrollpanel'
import SelectButton from 'primevue/selectbutton'
import Message from 'primevue/message'
import Divider from 'primevue/divider'
import { api, type HubState, type InboxItem, type SkillNode, type WorktreeInfo } from './api'

const toast = useToast()
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
const eventSources = new Map<string, EventSource>()

const navItems = [
  { key: 'sessions', label: '运行', icon: 'pi pi-play' },
  { key: 'worktrees', label: '工作区', icon: 'pi pi-sitemap' },
  { key: 'structure', label: 'Skills', icon: 'pi pi-code' },
  { key: 'inbox', label: '待审', icon: 'pi pi-inbox' },
  { key: 'history', label: '历史', icon: 'pi pi-clock' }
]

const kindOptions = [
  { label: '对话', value: 'chat' },
  { label: '改 Skill', value: 'edit' },
  { label: '处理工作区', value: 'attach' }
]

const queuedItems = computed(() => (state.value?.items ?? []).filter((item) => ['queued', 'proposed'].includes(item.status)))
const runningCount = computed(() => sessions.value.filter((session) => sessionStatus(session) === 'running').length)
const orderedSessions = computed(() => [...sessions.value].reverse())
const currentSession = computed(() => orderedSessions.value.find((session) => String(session.id) === selectedRun.value) || orderedSessions.value[0] || null)
const allSkills = computed(() => (state.value ? [...state.value.resident, ...state.value.adopted, ...state.value.inbox] : []))
const skillOptions = computed(() => allSkills.value.map((node) => ({ label: `${node.name}  (${node.path})`, value: node.path })))
const worktreeOptions = computed(() => worktrees.value.map((tree) => ({ label: `${tree.name}  ·  ${tree.path}`, value: tree.path })))

const pageMeta: Record<string, { title: string; subtitle: string }> = {
  sessions: { title: '运行', subtitle: '在面板内部执行 Codex，日志实时出现在这里' },
  worktrees: { title: '工作区', subtitle: '按目录名和最近改动排列，一键换成中心仓体系' },
  structure: { title: 'Skills', subtitle: '常驻、已采用和 inbox 原料' },
  inbox: { title: '待审', subtitle: '别人推上来的官方 Skill，先看再决定' },
  history: { title: '历史', subtitle: '入队、拍板和执行记录' }
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

function statusSeverity(status: string) {
  if (status === 'adopted' || status === 'completed') return 'success'
  if (status === 'rejected' || status === 'failed') return 'danger'
  if (status === 'proposed' || status === 'running') return 'warn'
  if (status === 'merged-into-3skill') return 'info'
  return 'secondary'
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
  toast.add({ severity: 'success', summary: action === 'adopt' ? '已采用' : action === 'merge' ? '已并入' : '已拒绝', life: 2200 })
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
    toast.add({ severity: 'success', summary: '已开始执行', life: 1800 })
  } catch (err) {
    toast.add({ severity: 'error', summary: err instanceof Error ? err.message : String(err), life: 4000 })
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
  <div class="shell">
    <aside class="sider">
      <div class="brand">
        <i class="pi pi-sparkles" />
        <div>
          <div class="brand-title">Skill Hub</div>
          <div class="brand-sub">本地中心仓</div>
        </div>
      </div>
      <nav class="nav">
        <Button
          v-for="item in navItems"
          :key="item.key"
          :label="item.label"
          :icon="item.icon"
          :severity="page === item.key ? 'primary' : 'secondary'"
          :text="page !== item.key"
          :outlined="page === item.key"
          class="nav-btn"
          @click="page = item.key"
        >
          <template #default>
            <span class="nav-label">
              <i :class="item.icon" />
              <span>{{ item.label }}</span>
            </span>
            <Badge v-if="item.key === 'inbox' && queuedItems.length" :value="queuedItems.length" />
            <Badge v-else-if="item.key === 'sessions' && runningCount" :value="runningCount" />
          </template>
        </Button>
      </nav>
      <Button label="新任务" icon="pi pi-plus" class="w-full" @click="openLaunch('chat')" />
    </aside>

    <section class="main">
      <header class="top">
        <div>
          <h2>{{ pageMeta[page].title }}</h2>
          <p>{{ pageMeta[page].subtitle }}</p>
        </div>
        <div class="top-actions">
          <Button label="刷新" icon="pi pi-refresh" severity="secondary" outlined @click="refresh()" />
          <Button v-if="page === 'inbox'" label="重新分析" severity="secondary" outlined @click="api.analyze()" />
        </div>
      </header>

      <Message v-if="error" severity="error" class="mb">{{ error }}</Message>

      <div v-if="state" class="body">
        <div v-if="page === 'sessions'">
          <Splitter style="height: 520px">
            <SplitterPanel :size="28" :min-size="20">
              <ScrollPanel style="height: 100%">
                <div v-if="!orderedSessions.length" class="empty">还没有任务，用下方输入框开始</div>
                <button
                  v-for="session in orderedSessions"
                  :key="String(session.id)"
                  class="run"
                  :class="{ on: currentSession && currentSession.id === session.id }"
                  @click="selectedRun = String(session.id)"
                >
                  <div class="run-title">{{ session.kind }}</div>
                  <div class="run-meta">{{ session.worktree || session.path || '中心仓' }}</div>
                  <Tag :value="sessionStatus(session)" :severity="statusSeverity(sessionStatus(session))" />
                </button>
              </ScrollPanel>
            </SplitterPanel>
            <SplitterPanel :size="72">
              <Card class="fill">
                <template #title>{{ currentSession ? `${currentSession.kind} · ${sessionStatus(currentSession)}` : '实时输出' }}</template>
                <template #content>
                  <ScrollPanel style="height: 420px">
                    <pre class="log">{{ currentSession ? (sessionLog(currentSession) || '等待输出…') : '选一个任务，或在下方描述你要做的事。' }}</pre>
                  </ScrollPanel>
                </template>
              </Card>
            </SplitterPanel>
          </Splitter>

          <Card class="composer">
            <template #title>下达任务</template>
            <template #content>
              <SelectButton v-model="launchKind" :options="kindOptions" option-label="label" option-value="value" class="mb" />
              <Select v-if="launchKind === 'edit'" v-model="launchPath" :options="skillOptions" option-label="label" option-value="value" filter placeholder="选择 Skill" class="mb w-full" />
              <Select v-if="launchKind === 'attach'" v-model="launchWorktree" :options="worktreeOptions" option-label="label" option-value="value" filter placeholder="选择工作区" class="mb w-full" />
              <Textarea v-model="launchIntent" auto-resize rows="3" placeholder="描述你要 Codex 做的事" class="w-full mb" />
              <div class="composer-foot">
                <span class="hint">内部执行，不弹窗。结果在上方实时刷新。</span>
                <Button label="运行" icon="pi pi-send" :loading="launching" @click="launchCodex" />
              </div>
            </template>
          </Card>
        </div>

        <div v-else-if="page === 'worktrees'">
          <Message severity="info" class="mb">扫描 {{ scanRoots.join('、') || '未配置' }} · 共 {{ worktrees.length }} 个工作区 · 按最近本地改动排序</Message>
          <Card v-for="tree in worktrees" :key="tree.path" class="mb">
            <template #title>{{ tree.name }}</template>
            <template #subtitle>{{ tree.path }}</template>
            <template #content>
              <div class="tags">
                <Tag :value="tree.attached ? '已用中心仓' : '仍用分支自带'" :severity="tree.attached ? 'success' : 'warn'" />
                <Tag v-if="tree.doNotAuto" value="勿自动" severity="secondary" />
                <Tag v-if="tree.ephemeral" value="临时" severity="info" />
                <Tag v-if="tree.locked" value="locked" />
                <Tag v-if="tree.prunable" value="prunable" severity="danger" />
                <Tag :value="formatChangedAt(tree.changedAtMs, tree.changedAt)" severity="secondary" />
              </div>
              <p class="hint">{{ tree.branch }} · {{ tree.cloneRoot }}</p>
              <p class="hint">
                {{ tree.officialPresent ? '官方 Skill 树还在磁盘' : '官方 Skill 树已拿走' }}
                ·
                {{ tree.overrideLinked ? 'override 已接通' : 'override 未接通' }}
              </p>
            </template>
            <template #footer>
              <Button
                :label="tree.attached ? '检查' : '改用本地 Skill'"
                @click="openLaunch('attach', { worktree: tree.path, intent: tree.attached ? '检查并修复这棵树与中心仓的挂接' : '剥官方 Skill，改挂中心仓' })"
              />
            </template>
          </Card>
        </div>

        <div v-else-if="page === 'structure'">
          <Card
            v-for="group in [
              { title: '常驻', nodes: state.resident },
              { title: '已采用', nodes: state.adopted },
              { title: 'Inbox', nodes: state.inbox }
            ]"
            :key="group.title"
            :title="group.title"
            class="mb"
          >
            <template #content>
              <p v-if="!group.nodes.length" class="empty">这里还是空的</p>
              <div v-for="node in group.nodes" :key="node.path" class="skill-row">
                <div>
                  <div class="run-title">{{ node.name }}</div>
                  <div class="hint">{{ node.path }}</div>
                </div>
                <div class="row-actions">
                  <Tag :value="node.attached ? '已挂接' : '仅中心仓'" :severity="node.attached ? 'success' : 'secondary'" />
                  <Button label="预览" size="small" severity="secondary" outlined @click="openSkill(node)" />
                  <Button label="用 Codex 改" size="small" @click="openLaunch('edit', { path: node.path, intent: '按客户端需要改这个 Skill' })" />
                </div>
              </div>
            </template>
          </Card>
        </div>

        <div v-else-if="page === 'inbox'">
          <Card title="并进 3 Skill 时的目标文件" class="mb">
            <template #content>
              <InputText v-model="mergeTarget" class="w-full" />
            </template>
          </Card>
          <p v-if="!queuedItems.length" class="empty">没有待审项。fetch/pull 官方 Skill 后会到这里。</p>
          <Card v-for="item in queuedItems" :key="item.id" class="mb">
            <template #title>{{ item.name }}</template>
            <template #subtitle>{{ item.unit }} · {{ item.sourceRef }}</template>
            <template #content>
              <Tag :value="item.status" :severity="statusSeverity(item.status)" />
              <p v-if="item.suggestion?.reason" class="hint">建议：{{ item.suggestion.action }} / {{ item.suggestion.reason }}</p>
            </template>
            <template #footer>
              <div class="row-actions">
                <Button label="预览" size="small" severity="secondary" outlined @click="openInbox(item)" />
                <Button label="用 Codex 改" size="small" @click="openLaunch('edit', { path: item.inboxPath || '', intent: '按客户端改这条 inbox Skill' })" />
                <Button label="采用" size="small" severity="success" @click="decide(item, 'adopt')" />
                <Button label="并进" size="small" severity="secondary" @click="decide(item, 'merge')" />
                <Button label="拒绝" size="small" severity="danger" @click="decide(item, 'reject')" />
              </div>
            </template>
          </Card>
          <Card v-if="state.items.length" title="全部记录">
            <template #content>
              <DataTable :value="state.items" size="small" striped-rows>
                <Column field="name" header="名称" />
                <Column field="status" header="状态" />
                <Column field="sourceRef" header="来源" />
              </DataTable>
            </template>
          </Card>
        </div>

        <div v-else>
          <p v-if="!history.length" class="empty">暂无历史</p>
          <Card v-for="(record, index) in history" :key="index" class="mb">
            <template #content>
              <pre class="log">{{ JSON.stringify(record, null, 2) }}</pre>
            </template>
          </Card>
        </div>
      </div>
      <p v-else-if="loading" class="empty">正在载入中心仓…</p>
    </section>
  </div>

  <Drawer v-model:visible="showPreview" position="right" :header="previewTitle" style="width: 42rem">
    <pre class="log">{{ preview }}</pre>
  </Drawer>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  min-height: 100vh;
}
.sider {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1.25rem 1rem;
  border-right: 1px solid var(--p-content-border-color);
}
.brand {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.brand i { font-size: 1.4rem; color: var(--p-primary-color); }
.brand-title { font-weight: 700; }
.brand-sub { font-size: 0.75rem; color: var(--p-text-muted-color); }
.nav { display: flex; flex-direction: column; gap: 0.35rem; flex: 1; }
.nav-btn { justify-content: space-between; }
.nav-label { display: flex; align-items: center; gap: 0.5rem; }
.main { min-width: 0; }
.top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  padding: 1.25rem 1.5rem 0.5rem;
}
.top h2 { margin: 0; }
.top p { margin: 0.35rem 0 0; color: var(--p-text-muted-color); }
.top-actions, .row-actions, .tags { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.body { padding: 0.75rem 1.5rem 1.5rem; }
.mb { margin-bottom: 1rem; }
.w-full { width: 100%; }
.fill { height: 100%; }
.empty, .hint, .run-meta { color: var(--p-text-muted-color); }
.empty { padding: 2rem 0; text-align: center; }
.run {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.8rem;
  border: 0;
  border-radius: 0.75rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.run.on { background: var(--p-content-hover-background); }
.run-title { font-weight: 650; margin-bottom: 0.25rem; }
.composer { margin-top: 1rem; }
.composer-foot { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.skill-row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}
.log {
  margin: 0;
  white-space: pre-wrap;
  font: 12.5px/1.55 ui-monospace, Consolas, monospace;
}
@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .sider { display: none; }
}
</style>
