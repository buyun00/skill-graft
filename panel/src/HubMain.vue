<script setup lang="ts">
import { computed, h, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  NAlert,
  NBadge,
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NFlex,
  NGradientText,
  NIcon,
  NInput,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NLayoutSider,
  NList,
  NListItem,
  NLog,
  NMenu,
  NPageHeader,
  NSelect,
  NSpace,
  NStatistic,
  NTabPane,
  NTabs,
  NTag,
  NText,
  NThing,
  useMessage,
  type MenuOption,
  type SelectOption
} from 'naive-ui'
import {
  AlbumsOutline,
  ChatboxEllipsesOutline,
  CodeSlashOutline,
  GitNetworkOutline,
  PlayCircleOutline,
  RefreshOutline,
  SparklesOutline,
  TimeOutline
} from '@vicons/ionicons5'
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
const eventSources = new Map<string, EventSource>()

const queuedItems = computed(() => (state.value?.items ?? []).filter((item) => ['queued', 'proposed'].includes(item.status)))
const runningCount = computed(() => sessions.value.filter((session) => sessionStatus(session) === 'running').length)
const orderedSessions = computed(() => [...sessions.value].reverse())
const currentSession = computed(() => orderedSessions.value.find((session) => String(session.id) === selectedRun.value) || orderedSessions.value[0] || null)
const allSkills = computed(() => (state.value ? [...state.value.resident, ...state.value.adopted, ...state.value.inbox] : []))

const skillOptions = computed<SelectOption[]>(() =>
  allSkills.value.map((node) => ({ label: `${node.name}  (${node.path})`, value: node.path }))
)
const worktreeOptions = computed<SelectOption[]>(() =>
  worktrees.value.map((tree) => ({ label: `${tree.name}  ·  ${tree.path}`, value: tree.path }))
)

const menuOptions = computed<MenuOption[]>(() => [
  { label: '运行', key: 'sessions', icon: () => h(NIcon, null, { default: () => h(PlayCircleOutline) }) },
  { label: '工作区', key: 'worktrees', icon: () => h(NIcon, null, { default: () => h(GitNetworkOutline) }) },
  { label: 'Skills', key: 'structure', icon: () => h(NIcon, null, { default: () => h(CodeSlashOutline) }) },
  {
    label: () => h(NBadge, { value: queuedItems.value.length, max: 99, offset: [14, 0] }, { default: () => '待审' }),
    key: 'inbox',
    icon: () => h(NIcon, null, { default: () => h(AlbumsOutline) })
  },
  { label: '历史', key: 'history', icon: () => h(NIcon, null, { default: () => h(TimeOutline) }) }
])

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

function statusType(status: string) {
  if (status === 'adopted' || status === 'completed') return 'success'
  if (status === 'rejected' || status === 'failed') return 'error'
  if (status === 'proposed' || status === 'running') return 'warning'
  if (status === 'merged-into-3skill') return 'info'
  return 'default'
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

const inboxColumns = [
  { title: '名称', key: 'name' },
  {
    title: '状态',
    key: 'status',
    render: (row: InboxItem) => h(NTag, { type: statusType(row.status), size: 'small' }, { default: () => row.status })
  },
  { title: '来源', key: 'sourceRef', ellipsis: { tooltip: true } }
]

onMounted(() => { void refresh() })
onUnmounted(() => {
  for (const source of eventSources.values()) source.close()
  eventSources.clear()
})
</script>

<template>
  <n-layout has-sider style="height: 100vh">
    <n-layout-sider bordered width="248" content-style="padding: 20px 12px">
      <n-space vertical :size="18">
        <n-space align="center">
          <n-icon :size="28" :component="SparklesOutline" color="#63e2b7" />
          <div>
            <n-gradient-text :size="18" type="success">Skill Hub</n-gradient-text>
            <n-text depth="3" style="display:block;font-size:12px">本地中心仓</n-text>
          </div>
        </n-space>
        <n-menu v-model:value="page" :options="menuOptions" />
        <n-button type="primary" block @click="openLaunch('chat')">
          <template #icon><n-icon :component="ChatboxEllipsesOutline" /></template>
          新任务
        </n-button>
      </n-space>
    </n-layout-sider>

    <n-layout>
      <n-layout-header bordered style="padding: 16px 24px 8px">
        <n-page-header :title="pageMeta[page].title" :subtitle="pageMeta[page].subtitle">
          <template #extra>
            <n-space>
              <n-button @click="refresh()">
                <template #icon><n-icon :component="RefreshOutline" /></template>
                刷新
              </n-button>
              <n-button v-if="page === 'inbox'" @click="api.analyze()">重新分析</n-button>
            </n-space>
          </template>
        </n-page-header>
      </n-layout-header>

      <n-layout-content content-style="padding: 16px 24px 24px" :native-scrollbar="false">
        <n-alert v-if="error" type="error" style="margin-bottom: 16px">{{ error }}</n-alert>

        <template v-if="state">
          <div v-if="page === 'sessions'">
            <n-flex :wrap="false" :size="16" style="min-height: 420px">
              <n-card title="任务" size="small" style="width: 280px; flex: none" :segmented="{ content: true }">
                <n-empty v-if="!orderedSessions.length" description="还没有任务，用下方输入框开始" />
                <n-list v-else hoverable clickable>
                  <n-list-item
                    v-for="session in orderedSessions"
                    :key="String(session.id)"
                    @click="selectedRun = String(session.id)"
                  >
                    <n-thing :title="String(session.kind)" :description="String(session.worktree || session.path || '中心仓')">
                      <template #header-extra>
                        <n-tag size="small" :type="statusType(sessionStatus(session))">{{ sessionStatus(session) }}</n-tag>
                      </template>
                    </n-thing>
                  </n-list-item>
                </n-list>
              </n-card>
              <n-card size="small" style="flex: 1; min-width: 0" :title="currentSession ? `${currentSession.kind} · ${sessionStatus(currentSession)}` : '实时输出'">
                <n-empty v-if="!currentSession" description="选一个任务，或在下方描述你要做的事" />
                <n-log v-else :log="sessionLog(currentSession) || '等待输出…'" language="naive-log" trim style="height: 420px" />
              </n-card>
            </n-flex>

            <n-card style="margin-top: 16px" title="下达任务">
              <n-tabs v-model:value="launchKind" type="segment" animated>
                <n-tab-pane name="chat" tab="对话" />
                <n-tab-pane name="edit" tab="改 Skill" />
                <n-tab-pane name="attach" tab="处理工作区" />
              </n-tabs>
              <n-space vertical>
                <n-select v-if="launchKind === 'edit'" v-model:value="launchPath" :options="skillOptions" filterable placeholder="选择 Skill" />
                <n-select v-if="launchKind === 'attach'" v-model:value="launchWorktree" :options="worktreeOptions" filterable placeholder="选择工作区" />
                <n-input v-model:value="launchIntent" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" placeholder="描述你要 Codex 做的事" />
                <n-space justify="space-between" align="center">
                  <n-text depth="3">内部执行，不弹窗。结果在上方实时刷新。</n-text>
                  <n-button type="primary" :loading="launching" @click="launchCodex">运行</n-button>
                </n-space>
              </n-space>
            </n-card>
          </div>

          <div v-else-if="page === 'worktrees'">
            <n-alert type="info" style="margin-bottom: 16px">
              扫描 {{ scanRoots.join('、') || '未配置' }} · 共 {{ worktrees.length }} 个工作区 · 按最近本地改动排序
            </n-alert>
            <n-list bordered hoverable>
              <n-list-item v-for="tree in worktrees" :key="tree.path">
                <n-thing :title="tree.name" :description="tree.path">
                  <template #header-extra>
                    <n-space>
                      <n-tag :type="tree.attached ? 'success' : 'warning'" size="small">{{ tree.attached ? '已用中心仓' : '仍用分支自带' }}</n-tag>
                      <n-tag v-if="tree.doNotAuto" size="small">勿自动</n-tag>
                      <n-tag v-if="tree.ephemeral" type="info" size="small">临时</n-tag>
                      <n-tag v-if="tree.locked" size="small">locked</n-tag>
                      <n-tag v-if="tree.prunable" type="error" size="small">prunable</n-tag>
                    </n-space>
                  </template>
                  <n-text depth="3">
                    {{ tree.branch }} · {{ formatChangedAt(tree.changedAtMs, tree.changedAt) }} · {{ tree.cloneRoot }}
                  </n-text>
                  <br>
                  <n-text depth="3">
                    {{ tree.officialPresent ? '官方 Skill 树还在磁盘' : '官方 Skill 树已拿走' }}
                    ·
                    {{ tree.overrideLinked ? 'override 已接通' : 'override 未接通' }}
                  </n-text>
                  <template #action>
                    <n-button type="primary" @click="openLaunch('attach', { worktree: tree.path, intent: tree.attached ? '检查并修复这棵树与中心仓的挂接' : '剥官方 Skill，改挂中心仓' })">
                      {{ tree.attached ? '检查' : '改用本地 Skill' }}
                    </n-button>
                  </template>
                </n-thing>
              </n-list-item>
            </n-list>
          </div>

          <div v-else-if="page === 'structure'">
            <n-card
              v-for="group in [
                { title: '常驻', nodes: state.resident },
                { title: '已采用', nodes: state.adopted },
                { title: 'Inbox', nodes: state.inbox }
              ]"
              :key="group.title"
              :title="group.title"
              size="small"
              style="margin-bottom: 16px"
            >
              <n-empty v-if="!group.nodes.length" description="这里还是空的" />
              <n-list v-else>
                <n-list-item v-for="node in group.nodes" :key="node.path">
                  <n-thing :title="node.name" :description="node.path">
                    <template #header-extra>
                      <n-space>
                        <n-tag size="small" :type="node.attached ? 'success' : 'default'">{{ node.attached ? '已挂接' : '仅中心仓' }}</n-tag>
                        <n-button size="small" @click="openSkill(node)">预览</n-button>
                        <n-button size="small" type="primary" @click="openLaunch('edit', { path: node.path, intent: '按客户端需要改这个 Skill' })">用 Codex 改</n-button>
                      </n-space>
                    </template>
                  </n-thing>
                </n-list-item>
              </n-list>
            </n-card>
          </div>

          <div v-else-if="page === 'inbox'">
            <n-card title="并进 3 Skill 时的目标文件" size="small" style="margin-bottom: 16px">
              <n-input v-model:value="mergeTarget" />
            </n-card>
            <n-empty v-if="!queuedItems.length" description="没有待审项。fetch/pull 官方 Skill 后会到这里。" />
            <n-list v-else bordered>
              <n-list-item v-for="item in queuedItems" :key="item.id">
                <n-thing :title="item.name" :description="`${item.unit} · ${item.sourceRef || ''}`">
                  <template #header-extra>
                    <n-tag size="small" :type="statusType(item.status)">{{ item.status }}</n-tag>
                  </template>
                  <n-text v-if="item.suggestion?.reason" depth="3">建议：{{ item.suggestion.action }} / {{ item.suggestion.reason }}</n-text>
                  <template #action>
                    <n-space>
                      <n-button size="small" @click="openInbox(item)">预览</n-button>
                      <n-button size="small" type="primary" @click="openLaunch('edit', { path: item.inboxPath || '', intent: '按客户端改这条 inbox Skill' })">用 Codex 改</n-button>
                      <n-button size="small" type="success" @click="decide(item, 'adopt')">采用</n-button>
                      <n-button size="small" @click="decide(item, 'merge')">并进</n-button>
                      <n-button size="small" type="error" @click="decide(item, 'reject')">拒绝</n-button>
                    </n-space>
                  </template>
                </n-thing>
              </n-list-item>
            </n-list>
            <n-card v-if="state.items.length" title="全部记录" size="small" style="margin-top: 16px">
              <n-data-table :columns="inboxColumns" :data="state.items" :bordered="false" size="small" />
            </n-card>
          </div>

          <div v-else>
            <n-empty v-if="!history.length" description="暂无历史" />
            <n-card v-for="(record, index) in history" :key="index" size="small" style="margin-bottom: 12px">
              <n-log :log="JSON.stringify(record, null, 2)" language="naive-log" trim style="height: 220px" />
            </n-card>
          </div>
        </template>
        <n-empty v-else-if="loading" description="正在载入中心仓…" />

        <n-divider />
        <n-flex v-if="state">
          <n-statistic label="常驻 Skill" :value="state.counts.resident" />
          <n-statistic label="已采用" :value="state.counts.adopted" />
          <n-statistic label="待审" :value="state.counts.queued" />
          <n-statistic label="运行中" :value="runningCount" />
        </n-flex>
        <n-descriptions v-if="state" :column="2" size="small" style="margin-top: 16px">
          <n-descriptions-item label="Hub">{{ state.hubRoot }}</n-descriptions-item>
          <n-descriptions-item label="游戏仓">{{ state.gameRepo || '未登记' }}</n-descriptions-item>
        </n-descriptions>
      </n-layout-content>
    </n-layout>
  </n-layout>

  <n-drawer v-model:show="showPreview" width="640">
    <n-drawer-content :title="previewTitle">
      <n-log :log="preview" language="naive-log" trim style="height: calc(100vh - 140px)" />
    </n-drawer-content>
  </n-drawer>
</template>
