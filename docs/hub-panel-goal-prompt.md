# Goal：用 graft-glass-ui 搭 Skill Hub 控制面板

你是一轮 **新的** Grok Build 4.6 / effort xhigh 会话。不要等人确认。不要进入 plan 模式。先读完本文再动手。

## 完成条件

1. Skill Hub 控制台网页按文末路由全部可打开，主页同时有 **待办态** 和 **空态**（待办条数为 0 时切空态）。
2. 视觉对齐用户给的稿：浅色玻璃侧栏 + 顶栏搜索/新建/铃铛/主题 + 问候 + 中间主卡 + 右侧工作区 + 底栏状态。组件来自 `E:\graft-glass-ui`。缺组件就在那个库里补，不要另起一套 CSS。
3. 前端 **只打** `http://127.0.0.1:18765`（开发时可用 Next rewrite 代理到它）。禁止 `import` `src/core`。按钮 = 现有 POST API。
4. 浏览器里走通：总览列表与 `sg list-worktrees` 路径一致；会话日志能跟 SSE；对可丢弃 inbox `POST /api/decide` reject 与 CLI 一致。
5. `npm test` 仍绿。不要改活树。不要把 `skills/`、session log 推进 git。

独立验收必须能复现，不能只截一张图。

---

## 必读

- `E:\graft-glass-ui` 组件库 + `/` 目录站 + `/hub` 控制台构图预览
- `E:\ozdqp-skill-hub\docs\系统设计与理念.md`
- `E:\ozdqp-skill-hub\docs\开发清单.md`（第 9 项旧页是 `web/index.html`，这次是重做）
- `E:\ozdqp-skill-hub\server\index.mjs`（唯一 HTTP 面）
- `E:\ozdqp-skill-hub\web\index.html`（旧页，可替换，不要留第二套算挂接的逻辑）

组件库导入：

```ts
import { HubShell, ToastProvider, ThemeProvider } from "graft-glass-ui/src/components";
```

或在 `panel/package.json` 写 `"graft-glass-ui": "file:../graft-glass-ui"`。库已有 `HubShell`：待办列表空则渲染 `HubEmpty`。构图预览：`http://localhost:3310/hub`（有事件 / 空白状态切换）。

---

## 硬规则

| 规则 | 含义 |
|---|---|
| CLI 是唯一命令面 | HTTP / 网页只 `exec` `sg` / `dist/control/cli.js` |
| 第一次挂接走对话 | 面板「连接工作区」走 `POST /api/worktree/attach`，不要静默修链冒充第一次 attach |
| 权威源在 hub | 不要把 `skills/` 推进 GitHub |
| 禁止改活树 | 冒烟用 `E:\ozdqp-cli-attach-probe` |
| 前端不算挂接 | 展示 `attached` / `overrideLinked` / `officialPresent` 以 API 为准 |

---

## 路由（前端）

用 App Router。侧栏 7 项对应：

| 路径 | 侧栏 | 数据 | 动作 |
|---|---|---|---|
| `/` | 总览 | `GET /api/state` + `/api/worktrees` + `/api/daemon` + `/api/health` | 待办主按钮：更新 → `/updates/:id`；修复 → `POST /api/worktree/attach` 或提示去工作区。空态 CTA → `/codex` |
| `/skills` | 技能库 | `GET /api/state` 的 resident / adopted / inbox | 点开 `GET /api/skill?path=` |
| `/updates` | 更新中心 | `state.items` | `POST /api/analyze`；`POST /api/decide` `{id, action}` |
| `/workspaces` | 工作区 | `GET /api/worktrees` | attach / detach POST |
| `/store` | 商店 | 先空态：本机中心仓不是 GRAFT 市场。文案说明「商店尚未接通」，不要假数据 |
| `/codex` | Codex 助手 | `GET /api/codex/sessions` | start / resume POST；日志 `EventSource /api/codex/session/stream?id=` |
| `/settings` | 设置 | `GET /api/state` 的 hubRoot / gameRepo + daemon | 只读展示 + 主题；不要在网页里改认仓规则 |

顶栏搜索：打开库里的 `CommandPalette`，条目来自 skills + worktrees + updates，回车 `router.push`。

主题：`ThemeProvider`，浅色默认更贴近稿，深色同样要能看。

---

## API 对照（不要另起后端）

已有（`server/index.mjs`）：

```
GET  /api/health
GET  /api/state          sg status
GET  /api/daemon         sg daemon status
GET  /api/worktrees      sg list-worktrees
GET  /api/skill?path=
GET  /api/history
GET  /api/codex/sessions
GET  /api/codex/session?id=
GET  /api/codex/session/stream?id=   SSE
POST /api/decide
POST /api/analyze
POST /api/codex/start
POST /api/codex/resume
POST /api/worktree/attach
POST /api/worktree/detach
```

主页字段映射：

| 稿上的字 | 来源 |
|---|---|
| 12 Skills | `state.counts.resident + adopted`（不要编） |
| 5 Worktrees | `worktrees.worktrees.length` |
| 3 待处理 | `queued + proposed`，再加上 `attached && (!overrideLinked \|\| officialPresent)` 的树 |
| 官方更新卡 | `items` 里 `queued` / `proposed`；标题 `name`；说明 `suggestion.reason`；版本用 `oldCommit`/`newCommit` 短哈希，没有就藏 `VersionChip` |
| 需要修复卡 | 工作树 `attached===true && (overrideLinked===false \|\| officialPresent===true)` 或未挂且用户从总览点修复 |
| 工作区「正常」 | `attached && overrideLinked && !officialPresent` |
| 工作区「需要修复」 | 已挂但链接不完整 |
| 工作区「未连接」 | `attached===false` |
| Git 连接 | `/api/health` ok 且 status 能读到 gameRepo |
| Codex 服务 | daemon 绿；或 sessions 接口可访问 |
| 本地存储 | **没有 API 就不要瞎编 GB 数**。没有就显示「本机 hub」+ `hubRoot`，或加一条极瘦的 `sg doctor` 字段（仍经 CLI）。禁止前端直接 `node:fs` 去盘 |

用户名：稿上是 Buyun。用 git `user.name` 只有走 CLI 才合法；没有就显示「本机」。不要写死一个假账号体系。

---

## 工程落点

推荐：

```
E:\ozdqp-skill-hub\panel\     Next.js 14 应用
  依赖 file:../graft-glass-ui
  next.config.mjs rewrites /api → http://127.0.0.1:18765
开发：panel 端口 3320，库预览仍 3310。
发布：静态导出到 E:\ozdqp-skill-hub\web\ ，继续由守护进程 :18765 同域托管。
```

旧 `web/index.html` 可以被导出结果替换。不要同时维护两套总览算法。

---

## 主页两种状态（必须都做）

**有事件：** `HubShell` 传入 `attention`（更新 + 修复）。右侧 `WorkspacePanel`。底栏 `StatusBar`。问候行带「N 待处理」。

**空白：** `attention=[]` → 库组件 `HubEmpty`（绿勾、「一切正常」、打开 Codex）。工作区应全是「正常 / 未连接」，不要在空态里还留「需要修复」。

构图参考：`E:\graft-glass-ui` 的 `/hub` 页，以及用户稿（浅色玻璃、侧栏总览高亮、顶栏胶囊搜索）。动效继续用库里的 lift / glass / spinning border，颜色走 CSS 变量。

---

## 建议实现顺序

1. `panel` 脚手架 + 代理 `/api` + `ThemeProvider`/`ToastProvider`/`HubShell`。
2. 总览接真实 JSON，确认空态/待办态切换。
3. 更新中心 + decide。
4. 工作区列表 + attach/detach（detach/attach 是会话，UI 要显示「已入队」而不是假装瞬间完成）。
5. 技能库只读。
6. Codex 页 SSE。
7. 设置只读。
8. 商店空态。
9. 导出进 `web/` 或说明 dev 端口；浏览器验收。

缺的组件只加在 `E:\graft-glass-ui\src\components\hub\`，并在库 `index.ts` 导出。

---

## 不要做

- 不要做清单第 10 项（多机）。
- 不要在网页里实现 preferLibrary / inode / 认仓。
- 不要新起一套 Python/静态 CSS 面板。
- 不要把 GRAFT 的 SOL 钱包、购物车接到 Hub。
