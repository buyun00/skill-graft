<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import {
  NLayout,
  NLayoutSider,
  NLayoutContent,
  NMenu,
  NButton,
  NCard,
  NSpace,
  NTag,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NInput,
  NAlert,
  NStatistic,
  NSpin,
  NModal,
  NSelect,
  NRadioGroup,
  NRadio,
  NForm,
  NFormItem,
  useMessage,
  type MenuOption,
  type SelectOption
} from 'naive-ui'
import { api, type HubState, type InboxItem, type SkillNode, type WorktreeInfo } from './api'

const message = useMessage()
const page = ref('overview')
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
const showLaunch = ref(false)
const mergeTarget = ref('skills/ozdqp-development/references/testing-and-verification.md')
const launchKind = ref<'chat' | 'edit' | 'attach'>('chat')
const launchPath = ref('skills/ozdqp-development')
const launchWorktree = ref('')
const launchIntent = ref('帮我查看并修改中心仓的 Skill。')

const menuOptions: MenuOption[] = [
  { label: '总览', key: 'overview' },
  { label: '结构', key: 'structure' },
  { label: '待审', key: 'inbox' },
  { label: '工作树', key: 'worktrees' },
  { label: '会话', key: 'sessions' },
  { label: '历史', key: 'history' }
]

const queuedItems = computed(() => (state.value?.items ?? []).filter((item) => ['queued', 'proposed'].includes(item.status)))

const skillOptions = computed<SelectOption[]>(() => {
  if (!state.value) return []
  return [...state.value.resident, ...state.value.adopted, ...state.value.inbox].map((node) => ({
    label: `${node.name}  (${node.path})`,
    value: node.path
  }))
})

const worktreeOptions = computed<SelectOption[]>(() =>
  worktrees.value.map((tree) => ({
    label: `${tree.name}  ·  ${tree.path}`,
    value: tree.path
  }))
)

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

function statusType(status: string) {
  if (status === 'adopted') return 'success'
  if (status === 'rejected') return 'error'
  if (status === 'proposed') return 'warning'
  if (status === 'merged-into-3skill') return 'info'
  return 'default'
}

async function refresh() {
  loading.value = true
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
    if (!launchWorktree.value && nextWorktrees.worktrees[0]) {
      launchWorktree.value = nextWorktrees.worktrees[0].path
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
  await refresh()
}

function openLaunch(kind: 'chat' | 'edit' | 'attach' = 'chat', preset?: { path?: string; worktree?: string; intent?: string }) {
  launchKind.value = kind
  if (preset?.path) launchPath.value = preset.path
  if (preset?.worktree) launchWorktree.value = preset.worktree
  if (preset?.intent) launchIntent.value = preset.intent
  showLaunch.value = true
}

async function launchCodex() {
  launching.value = true
  try {
    if (launchKind.value === 'edit') {
      await api.startCodex({ kind: 'edit', path: launchPath.value, intent: launchIntent.value })
    } else if (launchKind.value === 'attach') {
      await api.startCodex({ kind: 'attach', worktree: launchWorktree.value, intent: launchIntent.value })
    } else {
      await api.startCodex({ kind: 'chat', intent: launchIntent.value })
    }
    showLaunch.value = false
    message.success('已在面板内部启动 Codex，不会弹出新窗口。可在「会话」页看进度。')
    page.value = 'sessions'
    await refresh()
    startSessionPoll()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    launching.value = false
  }
}

let pollTimer = 0
function startSessionPoll() {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = window.setInterval(async () => {
    await refresh()
    const running = sessions.value.some((session) => session.status === 'running')
    if (!running && pollTimer) {
      window.clearInterval(pollTimer)
      pollTimer = 0
    }
  }, 3000)
}

onMounted(async () => {
  await refresh()
  if (sessions.value.some((session) => session.status === 'running')) startSessionPoll()
})

const inboxColumns = [
  { title: '名称', key: 'name', width: 180 },
  { title: '状态', key: 'status', width: 140, render: (row: InboxItem) => h(NTag, { type: statusType(row.status), size: 'small' }, { default: () => row.status }) },
  { title: '建议', key: 'suggestion', render: (row: InboxItem) => row.suggestion?.action || '—' },
  { title: '来源', key: 'sourceRef', ellipsis: { tooltip: true } }
]
</script>

<template>
  <n-layout class="hub-shell" has-sider>
    <n-layout-sider bordered :width="232" :collapsed-width="64" show-trigger content-style="padding-top: 18px">
      <div style="padding: 0 20px 16px">
        <div style="font-size: 18px; font-weight: 700; letter-spacing: 0.04em">Skill Hub</div>
        <div class="muted" style="margin-top: 4px; font-size: 12px">中心仓管理面板</div>
      </div>
      <n-menu v-model:value="page" :options="menuOptions" />
    </n-layout-sider>
    <n-layout-content content-style="padding: 28px 32px 48px" :native-scrollbar="false">
      <n-spin :show="loading">
        <div class="page-title">
          <h2>{{ menuOptions.find((item) => item.key === page)?.label }}</h2>
          <n-space>
            <n-button secondary @click="refresh">刷新</n-button>
            <n-button type="primary" @click="openLaunch('chat')">新开 Codex 对话</n-button>
          </n-space>
        </div>

        <n-alert v-if="error" type="error" style="margin-bottom: 16px">{{ error }}</n-alert>

        <template v-if="state">
          <div v-if="page === 'overview'">
            <n-card title="拉起 Codex" style="margin-bottom: 16px">
              <p>要改 Skill、处理新签出的分支，或随便问中心仓的事，点右上角或下面的按钮。会弹出一个 Codex CLI 窗口，不是在这个网页里聊天。</p>
              <n-space>
                <n-button type="primary" @click="openLaunch('chat')">新开一条对话</n-button>
                <n-button @click="openLaunch('edit', { intent: '按客户端需要改这个 Skill' })">改某个 Skill</n-button>
                <n-button @click="openLaunch('attach', { intent: '剥官方 Skill，改挂中心仓' })">给工作树换成本地体系</n-button>
              </n-space>
            </n-card>
            <div class="stat-grid">
              <n-card><n-statistic label="常驻 Skill" :value="state.counts.resident" /></n-card>
              <n-card><n-statistic label="已采用" :value="state.counts.adopted" /></n-card>
              <n-card><n-statistic label="待审" :value="state.counts.queued" /></n-card>
              <n-card><n-statistic label="已建议" :value="state.counts.proposed" /></n-card>
            </div>
            <n-card style="margin-top: 16px" title="中心仓">
              <p>Hub：{{ state.hubRoot }}</p>
              <p>游戏仓：{{ state.gameRepo || '未登记' }}</p>
              <p class="muted">最近入队：{{ state.lastIngest?.at || '尚无' }} {{ state.lastIngest?.ref || '' }}</p>
            </n-card>
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
              style="margin-bottom: 14px"
            >
              <n-space vertical>
                <div v-for="node in group.nodes" :key="node.path" style="display: flex; justify-content: space-between; gap: 12px; align-items: center">
                  <div>
                    <strong>{{ node.name }}</strong>
                    <div class="muted">{{ node.path }}</div>
                  </div>
                  <n-space>
                    <n-tag size="small" :type="node.attached ? 'success' : 'default'">{{ node.attached ? '已挂接' : '仅中心仓' }}</n-tag>
                    <n-button size="small" @click="openSkill(node)">预览</n-button>
                    <n-button size="small" type="primary" @click="openLaunch('edit', { path: node.path, intent: '按客户端需要改这个 Skill' })">用 Codex 改</n-button>
                  </n-space>
                </div>
                <div v-if="group.nodes.length === 0" class="muted">空</div>
              </n-space>
            </n-card>
          </div>

          <div v-else-if="page === 'inbox'">
            <n-card title="合并目标" style="margin-bottom: 14px">
              <n-input v-model:value="mergeTarget" />
            </n-card>
            <n-card v-for="item in queuedItems" :key="item.id" style="margin-bottom: 12px">
              <template #header>
                <n-space align="center">
                  <span>{{ item.name }}</span>
                  <n-tag size="small" :type="statusType(item.status)">{{ item.status }}</n-tag>
                </n-space>
              </template>
              <p class="muted">{{ item.unit }} · {{ item.sourceRef }}</p>
              <p v-if="item.suggestion?.reason">建议：{{ item.suggestion.action }} / {{ item.suggestion.reason }}</p>
              <n-space>
                <n-button size="small" @click="openInbox(item)">预览</n-button>
                <n-button size="small" type="primary" @click="openLaunch('edit', { path: item.inboxPath || '', intent: '按客户端改这条 inbox Skill' })">用 Codex 改</n-button>
                <n-button size="small" type="success" @click="decide(item, 'adopt')">采用</n-button>
                <n-button size="small" @click="decide(item, 'merge')">并进 3 Skill</n-button>
                <n-button size="small" type="error" @click="decide(item, 'reject')">拒绝</n-button>
              </n-space>
            </n-card>
            <n-card v-if="queuedItems.length === 0" title="待审为空">
              新的官方 Skill 会在 fetch/pull 后出现在这里。
            </n-card>
            <n-data-table v-if="state.items.length" :columns="inboxColumns" :data="state.items" style="margin-top: 16px" />
          </div>

          <div v-else-if="page === 'worktrees'">
            <n-card style="margin-bottom: 14px" title="扫描范围">
              <p class="muted">不再只看当前仓的 git worktree list，会扫这些盘符下的客户端目录，并展开每个独立 clone 的全部 worktree。</p>
              <p>范围：{{ scanRoots.join('、') || '未配置' }} · 找到 {{ worktrees.length }} 个客户端工作区</p>
            </n-card>
            <n-card v-for="tree in worktrees" :key="tree.path" style="margin-bottom: 12px">
              <template #header>
                <n-space>
                  <span>{{ tree.name }}</span>
                  <n-tag size="small" :type="tree.attached ? 'success' : 'warning'">{{ tree.attached ? '已用中心仓' : '仍用分支自带' }}</n-tag>
                  <n-tag v-if="tree.doNotAuto" size="small">勿自动</n-tag>
                  <n-tag v-if="tree.ephemeral" size="small" type="info">临时/工具树</n-tag>
                  <n-tag v-if="tree.locked" size="small">locked</n-tag>
                  <n-tag v-if="tree.prunable" size="small" type="error">prunable</n-tag>
                </n-space>
              </template>
              <p>{{ tree.path }}</p>
              <p class="muted">分支 {{ tree.branch }} · 最近改动 {{ formatChangedAt(tree.changedAtMs, tree.changedAt) }}</p>
              <p class="muted">clone：{{ tree.cloneRoot }}</p>
              <p class="muted">
                {{ tree.officialPresent ? '官方 Skill 树还在磁盘（尚未换成中心仓）' : '官方 Skill 树已拿走（正常）' }}
                ·
                {{ tree.overrideLinked ? 'AGENTS.override 已接到中心仓' : 'AGENTS.override 未接到中心仓' }}
              </p>
              <n-button type="primary" @click="openLaunch('attach', { worktree: tree.path, intent: tree.attached ? '检查并修复这棵树与中心仓的挂接' : '剥官方 Skill，改挂中心仓' })">
                {{ tree.attached ? '用 Codex 检查这棵树' : '用 Codex 改用本地 Skill' }}
              </n-button>
            </n-card>
          </div>

          <div v-else-if="page === 'sessions'">
            <n-card style="margin-bottom: 14px">
              <n-button type="primary" @click="openLaunch('chat')">新开 Codex 对话</n-button>
            </n-card>
            <n-card v-for="session in sessions.slice().reverse()" :key="String(session.id)" style="margin-bottom: 12px">
              <p>
                {{ session.kind }} ·
                <n-tag size="small" :type="session.status === 'completed' ? 'success' : session.status === 'failed' ? 'error' : 'warning'">{{ session.status }}</n-tag>
                · pid {{ session.pid }}
              </p>
              <p class="muted">{{ session.path || session.worktree || '中心仓内部执行，无新窗口' }}</p>
              <pre v-if="session.lastMessage" class="preview">{{ session.lastMessage }}</pre>
              <pre v-else-if="session.logTail" class="preview">{{ session.logTail }}</pre>
              <p v-if="session.error" class="muted">{{ session.error }}</p>
            </n-card>
            <n-card v-if="sessions.length === 0">还没有内部 Codex 任务。点上面的按钮即可在面板里跑。</n-card>
          </div>

          <div v-else>
            <n-card v-for="(record, index) in history" :key="index" style="margin-bottom: 10px">
              <pre class="preview">{{ JSON.stringify(record, null, 2) }}</pre>
            </n-card>
            <n-card v-if="history.length === 0">暂无历史。</n-card>
          </div>
        </template>
      </n-spin>
    </n-layout-content>
  </n-layout>

  <n-drawer v-model:show="showPreview" width="640">
    <n-drawer-content :title="previewTitle">
      <pre class="preview">{{ preview }}</pre>
    </n-drawer-content>
  </n-drawer>

  <n-modal v-model:show="showLaunch" preset="card" title="新开 Codex 对话" style="width: 640px">
    <n-form label-placement="top">
      <n-form-item label="对话类型">
        <n-radio-group v-model:value="launchKind">
          <n-space>
            <n-radio value="chat">自由对话</n-radio>
            <n-radio value="edit">改某个 Skill</n-radio>
            <n-radio value="attach">处理工作树</n-radio>
          </n-space>
        </n-radio-group>
      </n-form-item>
      <n-form-item v-if="launchKind === 'edit'" label="Skill 路径">
        <n-select v-model:value="launchPath" :options="skillOptions" filterable />
      </n-form-item>
      <n-form-item v-if="launchKind === 'attach'" label="游戏工作树">
        <n-select v-model:value="launchWorktree" :options="worktreeOptions" filterable />
      </n-form-item>
      <n-form-item label="你想让 Codex 做什么">
        <n-input v-model:value="launchIntent" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" />
      </n-form-item>
    </n-form>
    <template #footer>
      <n-space justify="end">
        <n-button @click="showLaunch = false">取消</n-button>
        <n-button type="primary" :loading="launching" @click="launchCodex">打开 Codex 窗口</n-button>
      </n-space>
    </template>
  </n-modal>
</template>
