# Skill Hub：现状、理念、已实现，以及下一步（双宿主发行）

> 写于 2026-08-21，同日按最终产品决定修正为：**同一独立核心，两个对等完整发行**。给新对话作现状说明。
> 详细步骤、真实环境和进度真相见 `双宿主独立核心改造实施计划.md`；本文只保留现状、理念和迁移摘要。
> 清单第 10 项（多机 / 小团队）仍然以后再做，本轮双宿主改造不是多机服务。

新对话建议：工作目录 `E:\ozdqp-skill-hub`；先读 `双宿主独立核心改造实施计划.md`，再读本文、`系统设计与理念.md` 第 2、9 节和 `三层本阶段规格.md` 的历史合同。

**产品决定（2026-08-21，必须遵守）：**
1. **落盘：** 不再坚持硬链接实时挂载。Hub 是版本库；按树 pin + 复制；不同树可以钉不同版本。不需要「改了一处另一处直接就变」。第一次从官方树切过来仍走对话。详见 §2.2 与 §5.3。
2. **双宿主：** 核心/Application 完全独立，不依赖 Codex / DSH / 网页 / 某一种安装方式。本地完整安装和 DSH 完整插件是两个对等发行，差异只在宿主适配、生命周期、会话执行、UI 和打包。DSH 发行在进程内装配共享 Application，**不依赖外置 `sg` 或 18765 daemon**；本地发行也不依赖 DSH。详见 §2.4、§5 与实施计划。

---

## 1. 当前现状（2026-08-22）

本机中心仓：`E:\ozdqp-skill-hub`（公开运行时仓 `buyun00/skill-graft`）。  
`skills/` 正文默认不入库、不上传。

| 面 | 现在怎样 |
|---|---|
| 本地命令 | `sg` / `ozdqp-hub` → Local composition → `HubApplication.execute(command)`；CLI 是本地 transport，不持有业务规则。 |
| HTTP | 守护进程默认 `:18765`；同进程调用 Local Host/Application，不 spawn CLI；typed 写入走 `POST /api/command`，旧入口保留 deprecated 兼容投影。 |
| 网页 | `panel/` Next 14 + `graft-glass-ui`，开发 **3320**，静态导出到 `web/`，由 daemon 同域托管 |
| 组件库 | `E:\graft-glass-ui`（库预览仍 **3310**）；panel 依赖 `file:../../graft-glass-ui` |
| 挂接 | 第一次走 **Codex 后台对话**（默认 `gpt-5.6-luna` + max）；会话只能提交绑定的 typed apply 命令；已挂树断链走 `repair-links`。 |
| 探针 | 自动真实验收使用 marker 所有的 run-id 隔离副本；`E:\ozdqp-cli-attach-probe` 只作固定只读基线，禁止改活树。 |
| 测试 | P1 候选：`npm test` 293 项、292 通过、0 失败、1 intentional skip；安全套件 28/28；源码外安装真实 P1 1/1，并完成浏览器 reject 写路径。 |
| 未做 | per-tree snapshot/pin 持久化、跨进程锁、`MaterializePort` copy 物化、完整 Local/DSH SessionRunner、DSH bundle/Host/Client/UI、双宿主并存与发布候选。 |

P1 共享 Contracts/Core/Application 已于 2026-08-22 完成真实安装、进程 trace 与浏览器写路径验收，见 [P1 证据](../artifacts/verification/P1/README.md)；当前实施指针为 P2。开发清单 **1–9 已完成**（含玻璃控制台），不要倒回去重做，除非冒烟证明坏了。

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
| Application 是唯一业务契约 | 本地 CLI/HTTP/网页与 DSH Host/Client 都调用同一组 Application commands。宿主不得直调 core 内部或重写领域规则；DSH 不通过外置 CLI 绕一圈。 |
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

核心功能必须能在两个发行中独立运行，所以**不能依赖任何一个平台或安装方式**。宿主差异和 UI 差异都拆出去。

```text
            contracts + core + Application commands
           库存、认树、pin、物化计划、decide、ingest、会话状态
                  不出现 Codex / DSH / HTTP / 安装方式分支
                              │ ports
                 ┌────────────┴────────────┐
                 ▼                         ▼
        本地发行适配与装配             DSH 发行适配与装配
        CLI/HTTP/daemon/panel           Cordis Host/Client/UI
        Node/Windows/Codex Runner       DSH services/in-process Runner
```

核心禁止 `node:http`、`powershell.exe`、Win32、`APPDATA`，也禁止 `dsh` / Codex 宿主 SDK。
控制层禁止出现 `preferLibrary`、inode 比较、认仓规则（认仓在 core + checkout-rules）。
适配层禁止出现「算不算领了」「第一次必须走对话」——那是核心的事。

---

## 3. 设计目标

长期目标：本机（以后可团队共享）一份 Skill **版本库**；每棵树领取并钉版本；官方更新人拍板；第一次从官方树切过来必须可审计。不追求「hub 一改、所有已挂树立刻同一份文件」。

近期产品目标（本文范围）：

1. **核心先独立，两个发行随后分别装配。**
   pin / snapshot / 物化 / 认领 / inbox / 会话状态由共享 core + Application 完成；本地与 DSH 都是完整宿主。

2. **Codex 独立跑 vs DSH 内部跑，都是适配层。**
   核心只 `enqueue` 会话任务。谁去执行（WMI 拉 `codex exec`，或 DSH `subagents`）是 `SessionRunner` 的不同实现。

3. **共享 Application 是唯一业务契约。**
   本地 CLI/HTTP/网页调用本地装配的 Application；DSH Host/Client 在进程内调用 DSH 装配的同一 Application。两边都不能直调 core 私有实现或复制认领算法，DSH 也不能要求用户先装外置 CLI。

4. **安装只有三种清晰状态。**
   完全不装：树继续用游戏仓官方 Skill；本地发行：完整 `sg setup`；DSH 发行：完整 `dsh plugin add`。两发行可单装也可并存，不做半套同步器。

5. **Skill 只给编辑器用；开场对齐，不是实时推送。**
   关编辑器不必同步。在拼系统提示词 / 扫 Skill 目录之前按 pin 复制一次。`AGENTS.override.md` 类总则开场就会进上下文，更要卡在第一拍之前。

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

当前 7 个查询命令和 12 个写命令共用版本化 command/result/error/event 合同。所有写命令携带 `requestId`，Application 负责幂等 replay/conflict、事务编排和审计；认树、claim、第一次 attach、pin 校验、冲突分类与 inbox 状态机位于纯 Core。第一次 attach/detach 的兼容流程由会话绑定的 `applyLegacyAttach` / `applyLegacyDetach` typed 命令进入同一 Application，旧 PowerShell 只保留机械 façade。

会话：Windows 上 WMI 拉起 `codex exec`，避免 Job Object 把对话和 CLI 一起杀掉。`exec` 一轮一退是正常的；连续性靠 `codexSessionId` + `resume`。HTTP 返回信封是 `{ ok, action, session: { id, status, … } }`，前端必须拆 `.session`。

### 4.2 HTTP（`:18765`）

`GET` health / state / daemon / worktrees / skill / history / codex sessions / session / SSE stream。  
typed 写命令统一走 `POST /api/command`；旧 `POST` decide / analyze / codex start|resume / worktree attach|detach 仍兼容，并返回 `Deprecation: true` 与 `/api/command` successor `Link`。两类入口都在 server 进程内调用同一 Application，不产生 CLI 中间子进程。

静态：`web/`（含 Next `[[...slug]]` 资源；`serveWeb` 要 decodeURI，且 `..` 按路径段判断，避免把 `[[...slug]]` 当成穿越）。

### 4.3 玻璃控制台（`panel/`）

路由：`/` 总览、`/skills`、`/updates`、`/updates/:id`、`/workspaces`、`/store`（「商店尚未接通」）、`/codex`（EventSource）、`/settings`。  
总览字段映射见 `panel/lib/overview-mapping.mjs`（测试直接 import 这份，禁止再抄一套）。  
Attach/detach 显示「已入队」，不把 POST 成功当成 `attached=true`。

### 4.4 树上挂接后的形态

以下为 **2026-08 现状实现**（Junction / HardLink）。产品下一步按 pin 复制到同样这些路径，见 §5.3；不要把实时硬链接当新功能做回去。

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

## 5. 当前下一步：P2–P10 的两个完整宿主发行

详细实现顺序和验收门禁以 `双宿主独立核心改造实施计划.md` 的 P0–P10 为准。本节只冻结架构边界。

### 5.1 共享层与宿主层

| 层 | 共享内容 | 宿主差异 |
|---|---|---|
| **contracts** | command/result/event/state/pin/snapshot schema | 无 |
| **core** | 认树、pin、物化计划、inbox、attach 策略、迁移判断 | 无 |
| **application** | `HubApplication.execute(command)`、事务、锁和审计编排 | 只依赖 ports |
| **本地发行** | — | Node/Windows、CLI/HTTP/daemon/panel、Codex Runner、setup/doctor |
| **DSH 发行** | — | Cordis Host/Client、workspace/settings/skills、DSH Runner、bundle 生命周期 |

本地 CLI 与 DSH Host 都是 Application 的调用方。DSH 插件不得通过 `exec sg` 或 18765 daemon 才能工作；本地发行也不得依赖 DSH。两个发行若共用数据根，必须共用 schema、snapshot、pin 和跨进程锁。

### 5.2 落盘与版本

Hub 是版本库。`runtimeRevision`（运行时代码）和 `librarySnapshot`（Skill 内容）必须分开；因为 `skills/**` 默认不进公开 Git，不能把仓库 HEAD 直接当 Skill pin。

每棵已领取树 pin 到一个内容快照。Application 先生成无副作用的 `planSync`，宿主 MaterializePort 再在取得锁、复检脏改后原子复制。脏文件拒绝覆盖；`unity-skills` 与项目自有 Skill 不删除；旧 Junction/HardLink 只通过显式兼容/迁移命令处理。

### 5.3 两个完整发行

**本地发行：** `sg setup` 后提供 CLI、daemon/API、独立网页、hooks 和 Codex SessionRunner，适配 Codex/CC/插件能力不足的编辑器。没有 DSH 也必须完整可用。

**DSH 发行：** `dsh plugin --profile <name> add <bundle>` 后提供 Host/Client、设置、工作区、Skills、pin/sync/inbox 和 DSH 进程内 SessionRunner。没有外置 `sg`、18765 daemon 和 Codex 也必须完整可用。

DSH 可用 `ctx.skills.register()` 注册当前 workspace 的钉定 Skill，可用 `ctx.subagents` 实现会话；这些都是 DSH 适配，不进入 shared core。设置页无父会话时，必须使用合法的顶层 Agent/任务入口，不能假设随时存在可续接的 parent。

### 5.4 实施与验收入口

P0 基线隔离和 P1 共享 Application 已完成并封口，当前从 P2 开始依次完成 snapshot/pin/锁、物化、本地发行、Codex Runner、DSH bundle、DSH UI、DSH Runner、双宿主并存与最终打包。每一步都要真实构建安装环境并启动宿主验证，完成后更新进度、提交并推送；单测不能替代真实安装和真实会话证据。

---

## 6. 硬规则（新对话每步都有效）

1. 不要改活树；冒烟 `E:\ozdqp-cli-attach-probe`。  
2. 不要把 `skills/`、session log、`skill-review/history` 推进 git。  
3. `npm test` 必须绿。  
4. 所有宿主只调共享 Application 公共合同，不直调 core 私有实现；DSH 不通过外置 CLI/18765 才能工作。
5. 第一次 attach 必须是会话，不是修链 / `sg sync` 冒充。
6. 不要第二套「这棵树领了哪版 / 算不算挂上」。  
7. 不要静默 `-PromoteFromWorktree` / `-Force`。  
8. 不要做清单第 10 项的多机服务本体。
9. 不要把「实时硬链接 / 改一处所有树立刻变」当新功能做回去；新路径默认复制 + pin。
10. shared core/Application 禁止出现 Codex / DSH 宿主 API、安装方式分支；宿主差异只进 adapters/composition。
11. 本地发行和 DSH 发行都是完整成品，任何一边都不能成为另一边的运行前提。

---

## 7. 新对话开场应读的文件

1. **执行真相** `docs/双宿主独立核心改造实施计划.md`
2. **现状摘要** `docs/现状与DSH插件化转移.md`
3. `docs/系统设计与理念.md` §2、§9
4. `docs/三层本阶段规格.md`（历史查询合同）
5. `src/core/ports.ts`、`src/core/worktrees.ts`、`src/control/cli.ts`、`overlay/prompts/attach.txt`
6. DeepSeek Harness 本机源码：`E:\deepseek-harness-master\docs\user\develop\basic\`、`packages\bundle\README.zh.md`、`apps\cli\reference\README.zh.md`
