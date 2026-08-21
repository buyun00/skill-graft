# Skill Hub：现状、理念、已实现，以及下一步（DSH 插件化）

> 写于 2026-08-21。给**新对话**当开工说明书，不要从旧的「网页已撤 / Vue 面板」段落开始。
> 权威理念仍见 `系统设计与理念.md`（层边界、挂接语义）；过时的实现细节以**本文**为准。
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
2. 复制会漂：改一处要对齐每一棵树。  
3. 别人 `fetch`/`pull` 的官方更新，不该在功能分支对话里当场归类。

因此：**权威源只有一份，在中心仓。** 工作树只挂链接，不持有工作流副本。

### 2.2 硬原则

| 原则 | 含义 |
|---|---|
| 链接，不复制 | 同盘：Skill 目录 Junction，`AGENTS.override.md` HardLink（普通用户 symlink 常失败）。判断接通必须能认 HardLink，不能只靠 `realpath`。 |
| 危险动作走对话 | **第一次**剥官方、改挂中心仓 = attach 会话。不要静默脚本冒充第一次 attach。 |
| 幂等修复才走脚本 | 已挂名单里的树，断链可 `repair-links`；树上 override 与 hub 字节不同则失败，不覆盖。 |
| CLI 是唯一命令面 | HTTP、hook、以后的网页/插件：只 `exec sg`，或经明确的控制层调 core。HTTP **禁止** `import src/core`。 |
| 前端不算挂接 | 展示字段以 `list-worktrees` / `/api/worktrees` 为准。 |
| 两套对话不要混 | Hub 里的 agent：cwd 永远是中心仓，可改 Skill/inbox/overlay，禁止写游戏仓玩法。日常开发对话在游戏树里用 3 Skill 写业务。碰某棵树用 `--add-dir`（或 DSH 的 cwd/workspace）。 |
| 官方更新进 inbox | hook → `ingest`；人 `decide` adopt / merge / reject。不要自动 adopt。 |
| `skills/` 不进公开 Git | 运行时（CLI、适配、面板、overlay）可以推；语料留本机。 |

### 2.3 两套 Skill

- **官方目录**：游戏仓 Git 跟踪的 `.agents/.claude/.codex` 大树 + 根 `AGENTS.md` / `CLAUDE.md`。  
- **本机 3 Skill**：`ozdqp-development` / `ozdqp-ui-development` / `ozdqp-git-workflow`，在 hub 的 `skills/`。  
- **不要剥掉** 游戏树上的 `unity-skills`（工程生成目录的 Junction）。  
- 游戏树根上的 `AGENTS.override.md` 必须指向 hub 那一份，不要覆盖并提交仓库正本 `AGENTS.md`。

### 2.4 分层

```text
人 / 网页 / Git hook / （下一步）DSH 插件
        │  控制面：时机、UI、把对话拉起来
        ▼
   sg CLI  ← 对外唯一命令面（HTTP 必须走这里）
        ▼
      core   库存、认树、修链、decide、ingest、会话记录（数据）
        ▼
     适配层  path / fs / LinkPort / git / persist
```

核心禁止 `node:http`、`powershell.exe`、Win32、`APPDATA`。  
控制层禁止出现 `preferLibrary`、inode 比较、认仓规则（认仓在 core + checkout-rules）。

---

## 3. 设计目标

长期目标没变：本机（以后可团队共享）一份 Skill 权威源，工作树只嫁接；官方更新人拍板；第一次切换必须可审计。

近期产品目标（本文范围）：

1. **安装只要两极，不要半套。**  
   - 完全不装：树继续用游戏仓官方 Skill。  
   - 完全安装：`sg setup`（CLI + 守护 + 链接 + 控制台）。  
   - 例外：**只用 DeepSeek Harness 的人**，允许「只装 DSH 插件」作为完整安装面——因为 DSH 插件是宿主进程内运行时，不是 CC/Codex 那种开场 spawn 一条命令。  
   - 不要再做「小同步器 + 插件」两头不讨好的第三套安装包。

2. **看起来像两个入口，代码仍是一套核心。**  
   DSH 插件与 CLI/网页只换控制面和「对话怎么拉起」，不叉开认挂算法。

3. **Skill 只给编辑器用。**  
   关编辑器不必同步。DSH 开着时，插件在宿主进程里后台对齐已挂树即可。不必为「关着 Web 也拉远程」再养一个专门的小 daemon（现有 `sg daemon` 是为 HTTP 面板和 hook 保活，不是为 Skill 实时性）。

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
Codex / Claude Code 的插件基本是技能包 + 开场 spawn 命令，**撑不起**「宿主里常驻对齐 + 开挂接对话 + 设置页」。它们的远端市场也**不能**代替本机链接和 attach 会话。

因此产品入口两极：

| 用户 | 安装 |
|---|---|
| 只用 DSH | `dsh plugin add` 一个 Hub 插件（完整能力面，关 DSH 就不同步） |
| 用 Codex / CC，或要 CLI / Git hook / 现有网页 | `sg setup` 完整 Hub |

代码上：**不要两套认挂、两套修链。** 只换控制面和 SessionRunner。

### 5.2 层怎么拆

```text
DSH 插件（控制）          CLI / HTTP / hook / 网页（控制）
  启动时 sync 已挂树
  设置卡片
  登记 ctx.skills / prompt section
  第一次 attach → SessionRunner(ds)
                              │
                              ▼
                     core（同一份）
                     status / list-worktrees / repairLinks
                     decide / ingest / 会话记录（数据）
                              │
                              ▼
                     适配（同一份盘）
                     LinkPort / fs / git / persist
                              │
              SessionRunner 端口（新，很小）
              enqueue attach|detach|edit|chat
                  ├─ 实现 A：现有 Codex WMI exec
                  └─ 实现 B：DSH spawn-in-process / continuable
```

- HTTP 仍只 exec CLI（硬规则不改）。  
- DSH 插件允许 `import` `dist/core` + `createHub`，或 exec `sg`（更厚、更慢，但边界更干净）。推荐：**插件调 core+适配**，不要复制算法；若担心分层被糊，至少修链/认树必须调用现有函数。  
- **禁止**在插件里再写一遍 `attached && overrideLinked && !officialPresent`。

### 5.3 插件要做的功能（范围）

1. **宿主启动（`dsh web` 起来，还没开对话）**  
   扫 worktree（用 core `listWorktrees`）。对 **已挂** 树：拉远程（若已配置）+ `repair-links`。未挂树只列出，不静默 attach。

2. **设置页（DSH 官方 settings card）**  
   本机 hub 路径、远程（可空）、上次同步、树状态（已挂/未连接/需要修复）、按钮：同步、连接（入队对话）、断开。

3. **进提示词之前**  
   用 setup / `agent/session-start`（原生监听，**不要**走 CC/Codex hooks 桥——官方写明桥的 SessionStart 是 best-effort，可能赶不上第一句）。登记 skills；总则用 section 读 `AGENTS.override.md`，不要覆盖仓库 `AGENTS.md`。

4. **第一次连接**  
   `SessionRunner` 开一轮 **DeepSeek** 对话（进程内 spawn 或 continuable），提示词继续用 `overlay/prompts/attach.txt` 语义（人点连接 = 已确认；业务脏文件不是阻塞；3 Skill 不同用 hub 为准）。不要 CLI 自己跑 Disable/attach-library。需要写盘权限（DSH 默认沙箱偏紧，attach 要能改 `.agents` / override）。

5. **工具（给模型，可选、宜瘦）**  
   `hub_status` / `hub_sync`；不要给模型直接 `mklink`。

6. **不要做**  
   第二个守护进程、第二个认仓、自动 adopt、静默第一次 attach、GRAFT 商店、多机同步服务、改活树冒烟。

### 5.4 Codex/CC 侧（本阶段可后做）

完整 Hub 已覆盖。若要「开场再对齐一次」，以后加 `SessionStart` 钩子 **只 exec `sg repair-links` 或 `sg sync`**，不要在钩子里实现业务。本阶段专注 DSH 插件 + SessionRunner 端口。

### 5.5 远程 skills

远端 → 本机缓存：复制或 `git pull`（硬链接做不到远程 inode）。  
本机缓存 → 多棵已挂树：仍 Junction/HardLink，不要每棵树再拷一份。  
未配置远程时：只修本机 hub 已有内容。第 10 项的「skills 私有远程」可以接在「拉缓存」上，但不要做成必须在线才能 `status`。

### 5.6 建议实现顺序（新对话按此勾）

1. 抽出 `SessionRunner` 端口 + Codex 实现挪到适配；CLI `attach` 行为与测试保持绿。  
2. DSH 插件脚手架：`apply(ctx)`、设置 schema、`dsh plugin add` 能加载。  
3. 启动时对已挂树 `repair-links`（调 core）。  
4. setup 窗口登记 skills + override section。  
5. 设置页：列表与同步按钮。  
6. 「连接」→ SessionRunner 的 DS 实现（探针树冒烟，禁止活树）。  
7. `npm test` 仍绿；DSH 侧用探针确认：启动后已挂树链接在、未挂树未被剥离。

### 5.7 DSH 能力边界（调查结论，避免新对话再踩）

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
6. 不要第二套「算不算挂上」。  
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
