# Skill Hub：现状、理念、已实现，以及下一步（DSH 插件化）

> 写于 2026-08-21（同日补：落盘从「硬链接实时挂载」改为「中心库 + 按树领取/复制」）。给**新对话**当开工说明书。
> 层边界仍见 `系统设计与理念.md` 第 9 节和 `三层本阶段规格.md`。**落盘语义以本文为准**，不要再把「改一处所有树立刻变」当硬目标。
> 清单第 10 项（多机 / 小团队）仍然以后再做，但本文的 DSH 插件**不是**第 10 项。

新对话建议：工作目录 `E:\ozdqp-skill-hub`；先读本文全文，再读 `系统设计与理念.md` 第 2、9 节和 `三层本阶段规格.md` 的端口表。不要进入 plan 模式才动手——但动手前必须把「SessionRunner 端口」和「禁止第二套认挂算法」写进实现，而不是先抄一套 DSH 业务逻辑。

---

## 1. 当前现状（2026-08-21）

本机中心仓：`E:\ozdqp-skill-hub`（公开运行时仓 `buyun00/skill-graft`）。  
`skills/` 正文默认不入库、不上传。

| 面 | 现在怎样 |
|---|---|
| 命令 | `sg` / `ozdqp-hub` → `dist/control/cli.js`。**唯一命令面。** |
| HTTP | 守护进程 `:18765`，只 `exec` CLI，禁止 `import src/core` |
| 网页 | `panel/` Next 14 + `graft-glass-ui`，开发 **3320**，静态导出到 `web/`，由 daemon 同域托管 |
| 组件库 | `E:\graft-glass-ui`（库预览仍 **3310**）；panel 依赖 `file:../../graft-glass-ui` |
| 挂接 | 第一次走 **Codex 后台对话**（默认 `gpt-5.6-luna` + max）；已挂树断链走 `repair-links` |
| 探针 | 冒烟只用 `E:\ozdqp-cli-attach-probe`，禁止改活树 |
| 测试 | `npm test` 须绿；前端不算挂接，`attached` / `overrideLinked` / `officialPresent` 以 API/CLI 为准 |
| 未做 | DSH 插件、SessionRunner 端口、把 Codex 会话执行从 CLI 里抽出去 |

开发清单 **1–9 已完成**（含玻璃控制台）。指针不要倒回去重做，除非冒烟证明坏了。

活数据典型形态：若干 worktree 已挂（链接完整），inbox 可能空，总览走「一切正常」；有事件路径由 `test/overview-mapping.test.mjs` 用夹具 JSON 覆盖。

---

## 2. 设计理念（不变）

### 2.1 要解决的三件事

1. 游戏仓每个 worktree 都摊一套官方 Skill，又大又和日常 3 Skill 打架。  
2. 别人 `fetch`/`pull` 的官方更新，不该在功能分支对话里当场归类。  
3. 不同工作树可能要**钉住不同 Skill 版本**（功能分支 vs 主干），不要求改 hub 一处则所有树立刻变。

因此：**权威源仍在中心仓（版本库）**；工作树是领取结果，不是实时挂载。现实现状仍是 Junction/HardLink；**下一步按复制 + 钉版本做**，链接变成可选实现，不再是理念硬约束。

### 2.2 硬原则

| 原则 | 含义 |
|---|---|
| 中心仓是库，树是领取 | hub 存正文与版本；某棵树用哪几个 Skill、哪个版本，记在该树（或 hub 侧 per-tree pin）。更新时复制过去（自动或手动），不要假设「改一处另一处立刻变」。 |
| 危险动作走对话 | **第一次**从官方大树切到本机 3 Skill = attach 会话（剥官方、写 pin、第一次物化）。不要静默脚本冒充第一次 attach。 |
| 已领取的更新才走脚本 | 已有 pin 的树：打开编辑器 / 点同步时按 pin 复制或按「升到最新」复制。树上有未提交的 Skill 脏改动则拒绝覆盖，不要悄悄盖。 |
| CLI 是唯一命令面 | HTTP、hook、以后的网页/插件：只 `exec sg`，或经明确的控制层调 core。HTTP **禁止** `import src/core`。 |
| 前端不算挂接 | 展示字段以 `list-worktrees` / `/api/worktrees` 为准。 |
| 两套对话不要混 | Hub 里的 agent：cwd 永远是中心仓，可改 Skill/inbox/overlay，禁止写游戏仓玩法。日常开发对话在游戏树里用 3 Skill 写业务。碰某棵树用 `--add-dir`（或 DSH 的 cwd/workspace）。 |
| 官方更新进 inbox | hook → `ingest`；人 `decide` adopt / merge / reject。不要自动 adopt。 |
| `skills/` 不进公开 Git | 运行时（CLI、适配、面板、overlay）可以推；语料留本机。 |

### 2.3 两套 Skill

- **官方目录**：游戏仓 Git 跟踪的 `.agents/.claude/.codex` 大树 + 根 `AGENTS.md` / `CLAUDE.md`。  
- **本机 3 Skill**：`ozdqp-development` / `ozdqp-ui-development` / `ozdqp-git-workflow`，在 hub 的 `skills/`。  
- **不要剥掉** 游戏树上的 `unity-skills`（工程生成目录的 Junction）。  
- 游戏树根上的 `AGENTS.override.md` 来自 hub 领取，**不要覆盖并提交仓库正本 `AGENTS.md`**。复制上去的 override / 3 Skill 应 `skip-worktree` 或等价，避免游戏仓 `git status` 被工作流文件污染。

### 2.4 分层

```text
人 / 网页 / Git hook / （下一步）DSH 插件
        │  控制面：时机、UI、把对话拉起来
        ▼
   sg CLI  ← 对外唯一命令面（HTTP 必须走这里）
        ▼
      core   库存、认树、pin、物化（复制）、decide、ingest、会话记录
        ▼
     适配层  path / fs / git / persist / MaterializePort（复制；链接仅兼容旧树）
```

核心禁止 `node:http`、`powershell.exe`、Win32、`APPDATA`。  
控制层禁止出现 `preferLibrary`、inode 比较、认仓规则（认仓在 core + checkout-rules）。

---

## 3. 设计目标

长期目标：本机（以后可团队共享）一份 Skill **版本库**；每棵树领取并钉版本；官方更新人拍板；第一次从官方树切过来必须可审计。不追求「hub 一改、所有已挂树立刻同一份文件」。

近期产品目标（本文范围）：

1. **安装只要两极，不要半套。**  
   - 完全不装：树继续用游戏仓官方 Skill。  
   - 完全安装：`sg setup`（CLI + 守护 + 链接 + 控制台）。  
   - 例外：**只用 DeepSeek Harness 的人**，允许「只装 DSH 插件」作为完整安装面——因为 DSH 插件是宿主进程内运行时，不是 CC/Codex 那种开场 spawn 一条命令。  
   - 不要再做「小同步器 + 插件」两头不讨好的第三套安装包。

2. **看起来像两个入口，代码仍是一套核心。**  
   DSH 插件与 CLI/网页只换控制面和「对话怎么拉起」，不叉开「这棵树领了哪版 Skill」。

3. **Skill 只给编辑器用。**  
   关编辑器不必同步。DSH 开着时，插件按各树的 pin **复制**需要的版本（或跳过已是该版本的树）。不必为关着 Web 再养同步 daemon。

4. **开场对齐，不是实时推送。**  
   在拼系统提示词 / 扫 Skill 目录之前对齐一次。整份 `SKILL.md` 一般是调用时才读盘；`AGENTS.override.md` 类总则开场就会进上下文，更要卡在第一拍之前。

---

## 4. 已经实现的功能

### 4.1 核心与 CLI

| 能力 | 入口 |
|---|---|
| 库存 | `sg status` / `GET /api/state` |
| 扫树 | `sg list-worktrees` / `GET /api/worktrees`（`attached` / `overrideLinked` / `officialPresent`） |
| 列 Skill | `sg list-skills` |
| 第一次挂接 | `sg attach --worktree` → 入队 Codex 会话，**不**在 CLI 里跑剥离脚本 |
| 已挂断链 | `sg repair-links`（脏 override 拒修） |
| 官方更新 | hook → `sg ingest`（可 `--dispatch` 分析） |
| 拍板 | `sg decide --id --action adopt\|merge\|reject` |
| 改 / 聊 / 剥 | `sg edit` / `chat` / `detach` / `resume` / `session` |
| 安装与保活 | `sg setup` / `doctor` / `daemon` |

会话：Windows 上 WMI 拉起 `codex exec`，避免 Job Object 把对话和 CLI 一起杀掉。`exec` 一轮一退是正常的；连续性靠 `codexSessionId` + `resume`。HTTP 返回信封是 `{ ok, action, session: { id, status, … } }`，前端必须拆 `.session`。

### 4.2 HTTP（`:18765`）

`GET` health / state / daemon / worktrees / skill / history / codex sessions / session / SSE stream。  
`POST` decide / analyze / codex start|resume / worktree attach|detach。  
静态：`web/`（含 Next `[[...slug]]` 资源；`serveWeb` 要 decodeURI，且 `..` 按路径段判断，避免把 `[[...slug]]` 当成穿越）。

### 4.3 玻璃控制台（`panel/`）

路由：`/` 总览、`/skills`、`/updates`、`/updates/:id`、`/workspaces`、`/store`（「商店尚未接通」）、`/codex`（EventSource）、`/settings`。  
总览字段映射见 `panel/lib/overview-mapping.mjs`（测试直接 import 这份，禁止再抄一套）。  
Attach/detach 显示「已入队」，不把 POST 成功当成 `attached=true`。

### 4.4 树上挂接后的形态

```text
<worktree>\.agents\skills\ozdqp-development     → Junction → hub
<worktree>\.agents\skills\ozdqp-ui-development
<worktree>\.agents\skills\ozdqp-git-workflow
<worktree>\.agents\skills\unity-skills          → 游戏工程（不进 hub）
<worktree>\AGENTS.override.md                   → HardLink → hub
<worktree>\.codex\local-overlay                 → Junction → hub\overlay
```

### 4.5 本机锚点

| 角色 | 路径 |
|---|---|
| hub | `E:\ozdqp-skill-hub` |
| API | `http://127.0.0.1:18765` |
| 面板开发 | `http://127.0.0.1:3320` |
| 组件库预览 | `http://localhost:3310` |
| 探针树 | `E:\ozdqp-cli-attach-probe` |
| 活树 | 只查不改 |

---

## 5. 下一步要做：DSH 插件化转移

### 5.1 为什么看起来像两套、实际应是一套

DeepSeek Harness 的插件是 **Cordis 进程内运行时**（`apply(ctx)`，可设设置页、可 `ctx.skills.register`、可在 **setup 窗口（第一句提示词之前）** 干活，可 `ctx.subagents` 拉起一轮 DS 对话）。  
Codex / Claude Code 的插件基本是技能包 + 开场 spawn 命令，**撑不起**「宿主里常驻对齐 + 开挂接对话 + 设置页」。它们的远端市场也**不能**代替本机 pin、复制物化和 attach 会话。

因此产品入口两极：

| 用户 | 安装 |
|---|---|
| 只用 DSH | `dsh plugin add` 一个 Hub 插件（完整能力面，关 DSH 就不同步） |
| 用 Codex / CC，或要 CLI / Git hook / 现有网页 | `sg setup` 完整 Hub |

代码上：**不要两套「这棵树领了哪版」。** 只换控制面和 SessionRunner。

### 5.2 层怎么拆

```text
DSH 插件（控制）          CLI / HTTP / hook / 网页（控制）
  启动时按 pin 物化已领取树
  设置卡片（升版本 / 钉住 / 手动复制）
  登记 ctx.skills / prompt section
  第一次 attach → SessionRunner(ds)
                              │
                              ▼
                     core（同一份）
                     status / list-worktrees / pin / materialize
                     decide / ingest / 会话记录（数据）
                              │
                              ▼
                     适配（同一份盘）
                     fs / git / persist / MaterializePort（复制为主）
                              │
              SessionRunner 端口（新，很小）
              enqueue attach|detach|edit|chat
                  ├─ 实现 A：现有 Codex WMI exec
                  └─ 实现 B：DSH spawn-in-process / continuable
```

- HTTP 仍只 exec CLI。  
- DSH 插件调同一份 core 的 pin/物化，禁止插件里再实现「算不算领了」。  
- 现有 `LinkPort` / `repair-links` 继续服务**已经 Junction 上去的旧树**，新路径默认复制。不要在新对话里先拆掉旧链接，除非探针上迁移动过。

### 5.3 落盘：复制 + 钉版本（新约定）

Hub 是版本库。每棵已领取的树有一份 pin（例如要哪些 Skill、各自哪个 commit/版本号）。打开 DSH 或点「同步到 pin」时，把对应正文 **复制** 到该树的 `.agents/skills/…` 和 `AGENTS.override.md`。

| 动作 | 谁做 | 说明 |
|---|---|---|
| 第一次领取 | attach 会话 | 剥官方大树、写 pin（默认钉当前 hub HEAD）、第一次复制。仍禁止静默。 |
| 同步到已钉版本 | 脚本 / 插件启动 | 树上已是该版本则跳过；脏改动则拒绝覆盖。 |
| 升到 hub 最新 | 人在设置页点 | 改 pin 再复制。A 树升、B 树不升 = 版本控制。 |
| 手动复制 | 设置页 / CLI | 同上，只是不自动。 |

不要把复制进游戏仓的工作流文件提交上去（`skip-worktree` 或只写 override）。`unity-skills` 仍不进 hub、不要剥。

DSH 还可以 **同时** `ctx.skills.register` 指向 hub 缓存里的钉定版本，减少对盘上副本的依赖；但只要还用 Codex/CC 打开同一棵树，盘上副本仍要在。

### 5.4 插件要做的功能（范围）

1. **宿主启动**  
   扫树。对 **已有 pin** 的树：按 pin 复制（自动）。未领取的只列出，不静默 attach、不覆盖官方 Skill。

2. **设置页**  
   hub 路径、远程、每棵树当前 pin / 是否落后 hub、是否脏。按钮：同步到 pin、升到最新、连接（第一次）、断开。

3. **进提示词之前**  
   原生 setup / `agent/session-start`（不要 CC/Codex 钩子桥）。登记当前 workspace 钉定的 skills；section 读该树的 override 副本，不改仓库 `AGENTS.md`。

4. **第一次连接**  
   SessionRunner 开 DS 对话；语义同现 attach 提示词。写 pin + 第一次复制。写盘权限要够。

5. **工具**  
   `hub_status` / `hub_sync`（按 pin 复制）。不要给模型 `mklink`。

6. **不要做**  
   第二个守护进程、第二个认仓、自动 adopt、静默第一次 attach、GRAFT 商店、多机服务、改活树、把「实时硬链接」当新功能做回去。

### 5.5 Codex/CC 侧（本阶段可后做）

完整 Hub 已覆盖。以后开场钩子只 `sg sync`（按 pin 复制），不要在钩子里实现业务。本阶段专注 DSH 插件 + pin/物化 + SessionRunner。

### 5.6 远程 skills

远端 → 本机 hub/缓存：`git pull` 或复制。  
hub/缓存 → 各树：按 **该树的 pin** 再复制。不是「拉完远程所有树立刻同一份」。  
未配置远程：只用本机 hub 版本。不要做成必须在线才能 `status`。

### 5.7 建议实现顺序（新对话按此勾）

1. 抽出 `SessionRunner`；CLI attach 测试仍绿。  
2. core：per-tree pin + `materialize`（复制；脏则失败）。旧 `repair-links` 先留着给已链接树。  
3. DSH 插件脚手架 + 设置 schema。  
4. 启动时对已 pin 树 materialize。  
5. setup 窗口登记该 workspace 的 skills + override section。  
6. 设置页：同步 / 升版本 / 连接。  
7. 「连接」→ SessionRunner DS 实现（仅探针）。  
8. `npm test` 绿；探针上确认：自动复制到 pin、脏文件不覆盖、未领取树官方 Skill 还在。

### 5.8 DSH 能力边界（调查结论，避免新对话再踩）

- 插件活在 **`dsh` 进程**，不是某一轮聊天。Web 关了，插件停。这符合「关编辑器不用同步」。  
- 原生插件 >> `dsh-hooks-claude-code` / `codex` 桥。挂接开场必须原生。  
- 可 `ctx.subagents.start('spawn', …)` 或 `startContinuable` 开 DS 子代理；也可继续用 `codex` provider。  
- `ctx.systemPrompt.section()` 管总则；`ctx.skills.register()` 管技能目录；调用时再 `inject()` 正文。  
- 预览版 API 会变；从 GitHub 装插件会跑 `prepare`（用户机器执行作者代码）。优先 npm 预构建或本机 path 开发。

---

## 6. 硬规则（新对话每步都有效）

1. 不要改活树；冒烟 `E:\ozdqp-cli-attach-probe`。  
2. 不要把 `skills/`、session log、`skill-review/history` 推进 git。  
3. `npm test` 必须绿。  
4. HTTP 仍禁止 `import src/core`。  
5. 第一次 attach 必须是会话，不是修链冒充。  
6. 不要第二套「这棵树领了哪版 / 算不算挂上」。  
7. 不要静默 `-PromoteFromWorktree` / `-Force`。  
8. 不要做清单第 10 项的多机服务本体。

---

## 7. 新对话开场应读的文件

1. **本文** `docs/现状与DSH插件化转移.md`  
2. `docs/系统设计与理念.md` §2 理念、§3 两套 Skill、挂接脚本语义  
3. `docs/三层本阶段规格.md` 端口与测试风格  
4. `src/core/ports.ts`、`src/core/worktrees.ts`、`src/control/cli.ts` 里 attach 入队  
5. `overlay/prompts/attach.txt`  
6. DeepSeek Harness：`docs/user/develop/basic/`、`docs/cookbook/extension-cookbook.md`（本地若无则 github.com/deepseek-ai/deepseek-harness）
