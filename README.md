# skill-graft

工作树不持有 Skill 副本。中心仓是权威源，各仓库用链接「嫁接」上来：改一处，已挂上的树同时看见。

GitHub 上的是**运行时**（CLI、适配层、面板、overlay）。你本机的 Skill 正文留在 `skills/`，默认不入库、不上传。

---

## 它解决什么

很多仓库会在每个 worktree 里再摊一套助手目录（Skill、agent、规则）。结果是：

1. **新签出就再摊一份。** 体积大、条目多，和你真正在用的那套往往还对不上。
2. **复制会漂。** 同一条 Skill 改了要同步到每一棵树，漏一次就两套真相。
3. **上游更新不该在功能分支上当场归类。** 写业务的对话不该停下来决定「这条官方 Skill 要不要吸收」。

skill-graft 把「本地工作流的权威源」放到**另一个仓库**里。工作树只挂 Junction / HardLink；官方更新进 inbox，人拍板；第一次剥官方、改挂中心，走后台 Codex 对话，不静默改盘。

理念上不绑死某一类项目。当前实现里「认不认这棵树」仍默认：根上同时有 `AGENTS.md` 和 `baloot_client`（先在游戏客户端仓上跑通的判定）。以后会收成可配置规则。

---

## 现在能做什么

| 能力 | 入口 | 说明 |
|---|---|---|
| 查库存 | `hub status` / `GET /api/state` | 常驻 / 已采用 / inbox、计数、关联仓 |
| 扫工作树 | `hub list-worktrees` / `GET /api/worktrees` | 是否已挂、override 是否接通、官方树是否还在盘上 |
| 列 Skill | `hub list-skills` | 三类节点；`attached` 表示游戏树上的链接是否指向 hub |
| 第一次挂接 | `hub attach --worktree <path>` | **后台 Codex 对话**（默认 `gpt-5.6-luna` + max），不是 CLI 直接跑脚本 |
| 已挂树断链 | `hub repair-links --worktree <path>` | 幂等修链接；内容与 hub 不一致会报错，避免悄悄覆盖 |
| 官方更新入队 | hook → `hub ingest` | `fetch`/`pull` 只吞进 inbox，不在功能树里做语义归类 |
| 拍板 inbox | `hub decide --id … --action adopt\|merge\|reject` | 采用 / 并入 / 拒绝 |
| 改 Skill / 闲聊 / 剥离 | `hub edit` / `chat` / `detach` / `resume` | 同样入队 Codex 会话 |
| HTTP | `npm run api` → :18765 | 查询与会话接口，只转发 CLI；网页已撤，以后重做 |

控制面漏斗：

```text
人 / HTTP / Git hook
        │
        ▼
   ozdqp-hub（CLI）     ← 对外唯一命令面
        ▼
      core
        ▼
     适配层（路径 / 盘 / 链接 / git）
```

HTTP 和 hook **不** `import` 核心函数，只执行 `dist/control/cli.js`。

第一次挂接由对话去做：侦察 → `manage-skill-visibility -Mode Disable` → `attach-library -ConfigureGit -PreferLibrary` → 验收。CLI 进程退出后对话仍在跑（Windows 上用 WMI 拉起，避免被 Job Object 一起杀掉）。

---

## 怎么用

### 准备

```text
git clone https://github.com/buyun00/skill-graft.git
cd skill-graft
npm install
npm run build
```

本机还需要：Node.js、Git。要跑 `attach` 对话：已登录的 [Codex CLI](https://github.com/openai/codex)。

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
npm run hub -- status
npm run hub -- list-worktrees
npm run hub -- list-skills
npm run hub -- --help
```

成功时 stdout 是 UTF-8 JSON。也可以设 `HUB_ROOT` 指向另一份 hub 数据根。

### 把一棵树改挂中心方案

```text
npm run hub -- attach --worktree D:\your-checkout
```

CLI 立刻返回 session（`status: running`、带 pid），Codex 在后台做剥离和链接。可选：

```text
--intent "…"           额外意图
--model gpt-5.6-luna   默认就是这个
--effort max           默认 max
--no-spawn             只入队，不拉对话（测试用）
```

挂上之后，树上应是：常驻 Skill 目录 → hub 的 Junction；`AGENTS.override.md` → hub 的 HardLink（或 symlink）；官方 `.claude/skills` / `.codex/skills` 不在磁盘。用 `list-worktrees` 看 `attached` / `overrideLinked` / `officialPresent`。

已挂树链接断了，不要再走第一次 attach：

```text
npm run hub -- repair-links --worktree D:\your-checkout
```

若有人改过树上的 override 且和 hub 内容不同，这条命令会失败并说明原因，避免悄悄用 hub 盖掉或反过来污染权威源。

### inbox

工作树若配了 hub 的 hook，`fetch`/`pull` 官方 Skill 只会 `ingest` 进中心仓 inbox。人再决定：

```text
npm run hub -- decide --id <id> --action adopt
npm run hub -- decide --id <id> --action merge --merge-target skills/ozdqp-development
npm run hub -- decide --id <id> --action reject
```

### HTTP（无网页）

```text
npm run api
```

`GET http://127.0.0.1:18765/api/health`、`/api/state`、`/api/worktrees`。管理页已删除，以后重做。

### 测试

```text
npm test              # tsc + 分层测试
npm run test:cli      # 只跑 CLI
npm run test:http     # HTTP 转发与字段一致
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

已经站住的是查询面和「CLI 为唯一控制面」。后面想做的，按依赖大致是：

1. **认仓规则可配置。** 去掉写死的 `AGENTS.md` + `baloot_client`，用名单或探测规则挂任意 Git 工作树。
2. **写盘命令收回核心。** `repair-links` / `ingest` / `decide` 现在背后还有 `.ps1`；应收成 Node 端口实现，Windows / macOS / Linux 同一套动词。
3. **会话可观测。** Codex 结束后回写 `sessions.json`（现在 detached 进程退出后状态可能仍停在 running）；`hub attach --wait` 可选等对话结束再打印验收。
4. **detach / edit 与 attach 同级。** 剥离、改某一条 Skill 都是后台对话，验收字段与查询 JSON 对齐。
5. **inbox 更完整。** 建议（adopt / merge / reject）由分析会话填写；面板只展示 CLI 给出的形状。
6. **多机 / 小团队。** 运行时在 GitHub，语料走另一条私有同步（或以后的团队服务），不要把别人的项目细节推进公开仓。
7. **新管理页。** 只消费 CLI/HTTP JSON，不再在前端算「算不算挂上」。

更细的层边界见 `docs/系统设计与理念.md` 第 9 节，本阶段查询规格见 `docs/三层本阶段规格.md`。

---

## 许可与范围

本仓库是本机实验用的嫁接运行时。不要把本仓文件提交进业务仓库。
