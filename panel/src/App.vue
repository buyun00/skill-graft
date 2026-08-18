<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import {
  NConfigProvider,
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
  darkTheme,
  type GlobalThemeOverrides,
  type MenuOption
} from 'naive-ui'
import { api, type HubState, type InboxItem, type SkillNode, type WorktreeInfo } from './api'

const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#7dd3fc',
    primaryColorHover: '#bae6fd',
    primaryColorPressed: '#38bdf8',
    bodyColor: '#0b1020',
    cardColor: '#151c31',
    modalColor: '#151c31',
    popoverColor: '#151c31',
    borderColor: '#263152',
    textColorBase: '#e8eefc'
  }
}

const page = ref('overview')
const loading = ref(false)
const error = ref('')
const state = ref<HubState | null>(null)
const history = ref<Array<Record<string, unknown>>>([])
const sessions = ref<Array<Record<string, unknown>>>([])
const worktrees = ref<WorktreeInfo[]>([])
const preview = ref('')
const previewTitle = ref('')
const showPreview = ref(false)
const mergeTarget = ref('skills/ozdqp-development/references/testing-and-verification.md')

const menuOptions: MenuOption[] = [
  { label: '总览', key: 'overview' },
  { label: '结构', key: 'structure' },
  { label: '待审', key: 'inbox' },
  { label: '工作树', key: 'worktrees' },
  { label: '会话', key: 'sessions' },
  { label: '历史', key: 'history' }
]

const queuedItems = computed(() => (state.value?.items ?? []).filter((item) => ['queued', 'proposed'].includes(item.status)))

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

async function startEdit(path: string, intent: string) {
  await api.startCodex({ kind: 'edit', path, intent })
  await refresh()
}

async function attachTree(path: string) {
  await api.attachWorktree(path)
  await refresh()
}

onMounted(refresh)

const inboxColumns = [
  { title: '名称', key: 'name', width: 180 },
  { title: '状态', key: 'status', width: 140, render: (row: InboxItem) => h(NTag, { type: statusType(row.status), size: 'small' }, { default: () => row.status }) },
  { title: '建议', key: 'suggestion', render: (row: InboxItem) => row.suggestion?.action || '—' },
  { title: '来源', key: 'sourceRef', ellipsis: { tooltip: true } }
]
</script>

<template>
  <n-config-provider :theme="darkTheme" :theme-overrides="themeOverrides">
    <n-layout class="hub-shell" has-sider>
      <n-layout-sider
        bordered
        :width="232"
        :collapsed-width="64"
        show-trigger
        content-style="padding-top: 18px"
      >
        <div style="padding: 0 20px 16px">
          <div style="font-size: 18px; font-weight: 700; letter-spacing: 0.04em">Skill Hub</div>
          <div class="muted" style="margin-top: 4px; font-size: 12px">中心仓管理面板</div>
        </div>
        <n-menu v-model:value="page" :options="menuOptions" />
      </n-layout-sider>
      <n-layout-content content-style="padding: 28px 32px 48px" :native-scrollbar="false">
        <n-spin :show="loading">
          <div class="page-title">
            <h2>
              {{ menuOptions.find((item) => item.key === page)?.label }}
            </h2>
            <n-space>
              <n-button secondary @click="refresh">刷新</n-button>
              <n-button type="primary" @click="api.analyze().then(refresh)">重新分析</n-button>
            </n-space>
          </div>

          <n-alert v-if="error" type="error" style="margin-bottom: 16px">{{ error }}</n-alert>

          <template v-if="state">
            <div v-if="page === 'overview'">
              <div class="stat-grid">
                <n-card>
                  <n-statistic label="常驻 Skill" :value="state.counts.resident" />
                </n-card>
                <n-card>
                  <n-statistic label="已采用" :value="state.counts.adopted" />
                </n-card>
                <n-card>
                  <n-statistic label="待审" :value="state.counts.queued" />
                </n-card>
                <n-card>
                  <n-statistic label="已建议" :value="state.counts.proposed" />
                </n-card>
              </div>
              <n-card style="margin-top: 16px" title="中心仓">
                <p>Hub：{{ state.hubRoot }}</p>
                <p>游戏仓：{{ state.gameRepo || '未登记' }}</p>
                <p class="muted">最近入队：{{ state.lastIngest?.at || '尚无' }} {{ state.lastIngest?.ref || '' }}</p>
              </n-card>
            </div>

            <div v-else-if="page === 'structure'">
              <n-card v-for="group in [
                { title: '常驻', nodes: state.resident },
                { title: '已采用', nodes: state.adopted },
                { title: 'Inbox', nodes: state.inbox }
              ]" :key="group.title" :title="group.title" style="margin-bottom: 14px">
                <n-space vertical>
                  <div v-for="node in group.nodes" :key="node.path" style="display: flex; justify-content: space-between; gap: 12px; align-items: center">
                    <div>
                      <strong>{{ node.name }}</strong>
                      <div class="muted">{{ node.path }}</div>
                    </div>
                    <n-space>
                      <n-tag size="small" :type="node.attached ? 'success' : 'default'">{{ node.attached ? '已挂接' : '仅中心仓' }}</n-tag>
                      <n-button size="small" @click="openSkill(node)">预览</n-button>
                      <n-button size="small" type="primary" @click="startEdit(node.path, '按客户端需要改这个 Skill')">用 Codex 改</n-button>
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
                  <n-button size="small" type="primary" @click="startEdit(item.inboxPath || '', '按客户端改这条 inbox Skill')">用 Codex 改</n-button>
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
              <n-card v-for="tree in worktrees" :key="tree.path" style="margin-bottom: 12px">
                <template #header>
                  <n-space>
                    <span>{{ tree.branch }}</span>
                    <n-tag size="small" :type="tree.attached ? 'success' : 'warning'">{{ tree.attached ? '已用中心仓' : '仍用分支自带' }}</n-tag>
                    <n-tag v-if="tree.doNotAuto" size="small">勿自动</n-tag>
                  </n-space>
                </template>
                <p>{{ tree.path }}</p>
                <p class="muted">官方目录 {{ tree.officialPresent ? '仍在磁盘' : '已剥离' }} · override {{ tree.overrideLinked ? '已链接' : '未链接' }}</p>
                <n-button v-if="!tree.attached" type="primary" @click="attachTree(tree.path)">用 Codex 改用本地 Skill</n-button>
              </n-card>
            </div>

            <div v-else-if="page === 'sessions'">
              <n-card v-for="session in sessions" :key="String(session.id)" style="margin-bottom: 12px">
                <p>{{ session.kind }} · pid {{ session.pid }} · {{ session.status }}</p>
                <p class="muted">{{ session.path || session.worktree }}</p>
              </n-card>
              <n-card v-if="sessions.length === 0">还没有由面板拉起的 Codex 对话。</n-card>
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
  </n-config-provider>
</template>
