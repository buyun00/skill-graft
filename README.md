# skill-graft

> **语言 / Language**: [简体中文](./README.md) · [English](./README.en.md)

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Status](https://img.shields.io/badge/status-local_experiment-orange.svg)
![Platform](https://img.shields.io/badge/platform-windows-lightgrey.svg)

中心仓是 Skill **版本库**。每棵工作树领取并钉住要用的版本，更新时复制（自动或手动）；不同树可以钉不同版本。不要求「改一处、已挂树同时看见」。

GitHub 上的是**运行时**（CLI、适配层、面板、overlay）。你本机的 Skill 正文留在 `skills/`，默认不入库、不上传。

**双宿主改造实施、真实环境与当前进度：** [`docs/双宿主独立核心改造实施计划.md`](./docs/双宿主独立核心改造实施计划.md)。现状摘要见 [`docs/现状与DSH插件化转移.md`](./docs/现状与DSH插件化转移.md)。

---

## 它解决什么

很多仓库会在每个 worktree 里再摊一套助手目录（Skill、agent、规则）。结果是：

1. **新签出就再摊一份。** 体积大、条目多，和你真正在用的那套往往还对不上。
2. **不同树可能要钉不同版本。** 不要求 hub 一改、所有已领树立刻同一份文件；对齐靠 pin + 复制，而不是实时链接。
3. **上游更新不该在功能分支上当场归类。** 写业务的对话不该停下来决定「这条官方 Skill 要不要吸收」。

skill-graft 把「本地工作流的权威源」放到**另一个仓库**里。树上是领取结果（按 pin 复制），不是实时挂载；官方更新进 inbox，人拍板；第一次从官方树切过来走后台对话，不静默改盘。现状实现仍是 Junction / HardLink；下一步改为复制 + 钉版本，见 [`docs/现状与DSH插件化转移.md`](./docs/现状与DSH插件化转移.md)。

理念上不绑死某一类项目。当前实现里「认不认这棵树」仍默认：根上同时有 `AGENTS.md` 和 `baloot_client`（先在游戏客户端仓上跑通的判定）。以后会收成可配置规则。

---

## 现在能做什么

| 能力 | 入口 | 说明 |
|---|---|---|
| 一键安装 | `setup.cmd` / `sg setup` | 配环境、把 `sg` 放进 PATH、静默守护、开机（登录）自启 |
| 查库存 | `sg status` / `GET /api/state` | 常驻 / 已采用 / inbox、计数、关联仓 |
| 扫工作树 | `sg list-worktrees` / `GET /api/worktrees` | 是否已挂、override 是否接通、官方树是否还在盘上 |
| 列 Skill | `sg list-skills` | 三类节点；`attached` 表示游戏树上的链接是否指向 hub |
| 第一次挂接 | `sg attach --worktree <path>` | **后台 Codex 对话**（默认 `gpt-5.6-luna` + max），不是 CLI 直接跑脚本 |
| 已挂树断链 | `sg repair-links --worktree <path>` | 幂等修链接；内容与 hub 不一致会报错，避免悄悄覆盖 |
| 官方更新入队 | hook → `sg ingest` | `fetch`/`pull` 只吞进 inbox，不在功能树里做语义归类 |
| 拍板 inbox | `sg decide --id … --action adopt\|merge\|reject` | 采用 / 并入 / 拒绝 |
| 改 Skill / 闲聊 / 剥离 | `sg edit` / `chat` / `detach` / `resume` | 同样入队 Codex 会话 |
| 保活 | `sg daemon status` / `GET /api/daemon` | 无窗口守护本地 HTTP API（:18765），挂了会拉起来 |
| HTTP / 网页 | 守护进程自动起；也可 `npm run api` | `:18765` API + 玻璃控制台；CLI、HTTP 和网页都进入同一进程内 Application，不经 CLI 子进程转发 |

当前本地发行调用链：

```text
人 / HTTP / Git hook
        │
        ▼
 CLI / HTTP / 网页 / hook（本地 transport）
        ▼
  HubApplication.execute(command)
        ▼
  纯 Core 规则与计划
        ▼
  低级端口 → Local 适配层（路径 / 盘 / 链接 / git / runner）
```

共享 `Contracts`、纯 `Core` 与 `HubApplication.execute(command)` 已成为本地发行的唯一业务契约；CLI 和旧 HTTP 形状只是兼容投影。目标不是让 DSH 再调用这条 CLI：后续 DSH 完整发行会在 DSH 进程内装配同一 Application，两边只在宿主适配、生命周期、UI、SessionRunner 和打包上分叉，彼此不构成运行前提。

第一次挂接和剥离仍先创建后台 Codex 会话，但提示只允许调用与该会话绑定的 typed 命令：`sg apply-legacy-attach` / `sg apply-legacy-detach`。Core 产出计划，Application 校验会话与幂等键，Local 适配器以可回滚事务执行；旧 PowerShell 文件不再承载可达的业务判断。CLI 进程退出后对话仍可继续运行。

---

## 怎么用

### 一键配置

本机需要 Node.js 和 Git。要跑 `attach` 对话，还要已登录的 [Codex CLI](https://github.com/openai/codex)。

```text
git clone https://github.com/buyun00/skill-graft.git
cd skill-graft
setup.cmd
```

也可以：`npm run setup`，或源码构建之后 `node dist/control/cli.js setup`。

这一步会：

1. 安装依赖并构建 CLI（若还没有）
2. 补齐 `skills/`、`overlay/`、`skill-review/` 布局
3. 把 `sg`（以及旧名 `ozdqp-hub`）写进 `%LOCALAPPDATA%\skill-graft\bin`，加入当前用户 PATH；若本机已有 `%APPDATA%\npm`，再放一份进去，已经打开的终端往往立刻就能用
4. 注册登录时自启的计划任务 `SkillGraft`（隐藏窗口）
5. 拉起静默守护进程，保活 `http://127.0.0.1:18765/api/health`

然后**新开一个终端**：

```text
sg status
sg doctor
sg --help
```

编辑器里已经打开的终端如果找不到 `sg`，重启编辑器。卸载：`sg uninstall`（只拆命令、PATH、守护和自启，不删这份仓库，也不动 `skills/`）。

把你的 Skill 放进本机 `skills/`（该目录不进 git）。典型布局：

```text
skills/
  <resident-a>/SKILL.md
  <resident-b>/SKILL.md
  inbox/                 # ingest 写到这里
  adopted/
AGENTS.override.md       # 挂到工作树根上的那一份
overlay/scan-roots.txt   # 扫盘根，一行一个目录
```

### 查询

```text
sg status
sg list-worktrees
sg list-skills
sg --help
```

成功时 stdout 是 UTF-8 JSON。也可以设 `HUB_ROOT` 指向另一份 hub 数据根。还没装 `sg` 时可以用 `npm run hub -- status`。

### 把一棵树改挂中心方案

```text
sg attach --worktree D:\your-checkout
```

CLI 立刻返回 session（通常为 `queued` / `running`，启动后带 pid），Codex 在后台做侦察并提交受会话授权的 typed 应用命令（现状物化仍是链接）。可选：

```text
--intent "…"           额外意图
--model gpt-5.6-luna   默认就是这个
--effort max           默认 max
--no-spawn             只入队，不拉对话（测试用）
```

**现状实现：** 挂上之后，树上应是：常驻 Skill 目录 → hub 的 Junction；`AGENTS.override.md` → hub 的 HardLink（或 symlink）；官方 `.claude/skills` / `.codex/skills` 不在磁盘。用 `list-worktrees` 看 `attached` / `overrideLinked` / `officialPresent`。

**产品下一步：** 按树 pin + 复制同一批路径，不再要求实时硬链接。详见转移文档。

已挂树链接断了，不要再走第一次 attach：

```text
sg repair-links --worktree D:\your-checkout
```

若有人改过树上的 override 且和 hub 内容不同，这条命令会失败并说明原因，避免悄悄用 hub 盖掉或反过来污染权威源。

### inbox

工作树若配了 hub 的 hook，`fetch`/`pull` 官方 Skill 只会 `ingest` 进中心仓 inbox。人再决定：

```text
sg decide --id <id> --action adopt
sg decide --id <id> --action merge --merge-target skills/ozdqp-development
sg decide --id <id> --action reject
```

### HTTP 与网页

配置器会把 API 交给守护进程保活。也可以前台起一份：

```text
npm run api
```

打开 `http://127.0.0.1:18765/` 使用管理页。`GET /api/health`、`/api/state`、`/api/worktrees`、`/api/daemon` 保留兼容；typed 写命令走 `POST /api/command`。旧 `/api/decide` 等入口会返回 deprecated 标记，但同样进入进程内 Application，不会 spawn CLI。

```text
sg daemon status
sg daemon stop
sg daemon start
```

### 测试

```text
npm test              # tsc + 分层测试
npm run test:cli      # 只跑 CLI
npm run test:http     # HTTP/Application 与兼容字段一致
```

---

## 故意不进 GitHub 的东西

| 路径 | 为什么 |
|---|---|
| `skills/**`（除 `skills/README.md`） | 本机工作流和项目细节 |
| `skill-review/sessions.json`、对话 log / prompt | 本机会话 |
| `dist/`、`node_modules/` | 构建产物 |

公开仓只保存嫁接运行时。换一台机器：克隆 skill-graft，再把自己的 `skills/` 拷过去或另作同步。

---

## 展望

已经站住的是共享 `Contracts/Core/Application` 和完整 Local composition；CLI、HTTP、网页与兼容 PowerShell façade 不再各自拥有业务策略。后续按双宿主实施计划继续：

1. **P2：snapshot、pin、状态迁移与跨进程锁。** 建立内容寻址的版本库真相和崩溃可恢复事务。
2. **P3：按 pin 复制物化。** 用普通文件树替代实时 Junction / HardLink，并完成冲突、漂移、回滚与路径安全。
3. **P4–P6：DSH 独立完整发行。** 在 DSH 进程内装配同一 Application，补齐 host-native Runner、生命周期和 DSH UI。
4. **P7–P8：迁移、兼容与双宿主并存。** 验证 Local-only、DSH-only 和两者同机互不依赖。
5. **P9–P10：升级、卸载、回滚与最终发布。** 用真实安装包、真实进程和真实 UI 封口可追溯发行候选。

更细的层边界见 `docs/系统设计与理念.md` 第 9 节，本阶段查询规格见 `docs/三层本阶段规格.md`。

---

## 许可与范围

本仓库基于 **Apache License 2.0** 发布，详见 [LICENSE](./LICENSE)。

本仓库是本机实验用的嫁接运行时。不要把本仓文件提交进业务仓库。
