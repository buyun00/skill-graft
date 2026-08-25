# P5 Codex SessionRunner 与本地真实 attach 证据

## 结论

P5 于 2026-08-25 按用户最新授权的“最小真实运行优先”完成实现与精简封口。共享层已经冻结宿主无关的 Session 合同；Local 发行已经具备 durable repository/binding/runner、daemon 启动恢复、CLI/API/SSE/Panel 的 start/resume/cancel/status/events 接口，以及显式 Node/Codex module、只读凭据来源和 run-owned 子进程 home 边界。

当前工具审核会终止生产 WMI 启动的 controller。按“最多一次最小重试，仍失败则以 CLI/结构化事件/真实进程证据收口”的授权，本轮没有继续重跑完整 harness，而是直接使用同一安装 tarball 内的 controller 完成一次真实 Codex start、同 thread resume 和 Job Object cancel。结构化 receipt/status/events、真实 PID 退出、端口和 lease 收口均已核对；没有读取或断言模型自由文本。真实 smoke 后只追加了两项 fail-closed safety hardening：清空 controller 继承的非安全环境，以及禁止 V2 旧 GET/SSE 路由返回 raw log；两项有 focused 证据，但遵守“不循环”要求没有再次调用真实 provider。

这份记录不把 fallback controller 证据冒充完整 API/浏览器 attach，也不声称取得真实 materialization marker。原计划中更强的完整 installed API/Panel、daemon 中断恢复和物化一致性门禁均明确进入本页 backlog，后续 P9/P10 再评估。

- P5 起点 / 早期交接：`74fbd5228c2cd0ce0f163aa14646e2a8a98c69c6`
- 共享 Session 合同唯一写入提交：`29ea16e32f95a6cd9e1f31b90d223d6c332cf509`
- Application task/cancel 边界提交：`d2a96110512114c430f370ae4c21616bb83c1b13`
- 分支：`codex/skill-graft-local-p5-implementation`
- 最终实现 / 已核对远端 SHA：`eae42d9cb2a7356f8f0b975ab98b4cf357a023ee`
- 阶段封口：本记录所在提交
- 最终 real run-id：`p5-final-20260825-11af3355`
- marker-owned 隔离根：`F:\skill-graft-p5-runs\p5-final-20260825-11af3355`
- 脱敏机读摘要：[smoke.json](./smoke.json)
- 原始 tgz、prompt、stdout/stderr、Codex history、auth 与运行态只保留在隔离根，不进 Git

## 实现边界

### 共享合同与 Application

- `SessionTask` 只描述 `kind/target/intent/prompt/steps/completion/capabilities`，不包含 Codex、WMI、Job Object 或宿主分支。
- `SessionRunnerPort` 固定为 `start/resume/cancel/status/events`；runner snapshot、event、receipt、error code 均为宿主无关结构。
- 当前状态统一为 `queued/running/awaiting/failed/completed/cancelled`。旧持久化的 `waiting` 仅在读取时归一为 `awaiting`，不建立第二套状态机。
- attach 的 runner exit 0 只进入 `awaiting`；Application 收到真实 materialization proof 后才允许进入 `completed`。
- attach/detach/edit/chat 的业务提示、步骤和完成条件由 Application 构造，Local runner 只执行已经绑定的任务。

### Local repository、binding 与 runner

- session/attempt 使用 durable compare-and-swap repository；每个 attempt 独立保存 request/status/receipt/events，V2 对外只投影有界结构化事件；旧 GET 与 SSE 路由同样不返回 raw stdout、log tail 或 last message。
- binding 接收显式 `node.exe`、显式 `@openai/codex/bin/codex.js` 和显式 credential home。生产配置通过 `HUB_CODEX_NODE`、`HUB_CODEX_MODULE`、`HUB_CODEX_CREDENTIAL_HOME` 或 composition options 注入；module/credential 缺失时 fail closed，不再回退真实 `APPDATA/HOME`。它只把 `auth.json` 复制进 session-owned `CODEX_HOME`，并把 `HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG_CONFIG_HOME/TEMP/TMP` 指向 run-owned 根。
- Local runner 不调用 `codex.cmd`；start/resume 均以 stdin 传 prompt，解析 JSONL thread/event，controller 由 Windows Job Object 管理整棵子进程树。controller 启动 child 前清空继承环境，只保留最小 OS/Path 基线与 binding 明确传入的 run-owned 配置键；provider/token 变量不会隐式下传。
- cancel 先写 attempt cancel marker，再等待 controller 的 `cancelled` receipt；不会仅凭“已请求”把 Application session 标成 cancelled。
- Local host 的启动恢复通过 typed `reapSessions` 进入 Application transaction，避免在 durable transaction 之外写 session state。

### CLI、API、SSE 与 Panel

- CLI 继续使用 typed `session start/show/list/events/resume/cancel`，没有新增旁路协议。
- HTTP 写操作继续走 `/api/command`；取消使用 `kind=cancelSession`。SSE 复用既有 session endpoint，并把 `awaiting/completed/failed/cancelled` 作为 terminal 观察状态。
- capability cookie/header 门禁保持不变；P5 V2 SSE 只发送归一化 session/event，不镜像 raw runner log。
- Codex Panel 展示真实状态、步骤、结构化事件，并根据 `canResume/canCancel` 开关继续/取消操作。

## 自动化候选门禁

| 验证 | 结果 |
|---|---|
| `npm run build:release` | pass；TypeScript、Panel export、8 HTML / 38 canonical web files、release verify 均完成 |
| 恢复修复后的 `npm run build` | pass |
| 恢复修复后的 `npm run verify:release` | pass；8 HTML / 38 files |
| P5 focused tests | pass；9/9，约 25.6 秒 |
| focused 覆盖 | controller completion/environment scrub、Job tree cancel、start/resume receipt、cancel confirmation、typed Application cancel、startup recovery transaction、3 个合同测试 |
| V2 raw HTTP projection | focused pass；旧 GET/SSE 不返回 V2 raw runner log，legacy 读取兼容保留 |
| real harness / fake CLI syntax | `node --check` pass |
| whitespace | `git diff --check` pass；仅 Git 的 CRLF 工作树提示 |

本轮没有运行两小时默认套件、P4 60 分钟 harness、fault matrix、性能或长期稳定性测试。

## 安装包与隔离边界

| 字段 | 结果 |
|---|---|
| tarball | `ozdqp-skill-hub-0.1.0.tgz`；1,006,866 bytes；run 内唯一 tgz |
| tarball SHA-256 | `f7ae0a641d320d05d3c1cbeb83b50997705657f6d7025bd54ce05c88be7c12e1` |
| run marker SHA-256 | `a9fb2efedc09ca7c267b6cfd4b9a6eb33c10fa8c819e42fd1594fa148a071f98` |
| 真实 provider 使用的 installed controller SHA-256 | `d325bda58428630d840e65a577eec660799a03a0be84906cd099e37e5eeeadf0` |
| safety hardening 后最终源码 controller SHA-256 | `0153187ef861b803cd87be24cc39c84dbe1462ade496b741ca2ccccfad9da114`；focused controller test 通过，未再次调用 provider |
| Application session / attempt SHA-256 | `99ee1f3c74858788178f6c0493ad4fa1b9b6ab3576820fecadccba32c9497472` / `1a999cf019c79c283e13407d7a5c4042745644bc18451f8287ff035fb9001804` |
| 隔离 auth | session-owned `CODEX_HOME/auth.json` 存在；原 auth 内容和 hash 不入库 |
| probe 终态 | HEAD `ee7c9f775de7efb20e3fafe0069801bfa4b8c07b`；tree `ecc2b1c6369ecd30e7a03cbf08dcab67e204d5e5`；dirty=0 |

真实 smoke 的身份/配置根已由 request allowlist 覆写为 run-owned；最终 safety hardening 又在启动 child 前清空其余继承环境，只重建最小 OS/Path 基线。执行入口是 `node.exe + codex.js`，不是 `.cmd` shim。隔离根之外未创建验收 probe，也未触碰 OZDQP 活工作树。

## 真实 controller start/resume/cancel

生产 WMI launcher 在当前工具审核下取得 PID 后被外部终止，未能留下完整 receipt。唯一最小重试改为直接前台运行同一已安装 controller；这改变的是 launcher 入口，不改变 controller、Codex module、隔离环境、事件解析或 Job Object 取消逻辑。

### start

- 真实 Codex thread SHA-256：`14362d9662a9e209915cb11ec42d8e829fb260575c5245ce68a09b772105e2af`。
- controller PID `71320`，child PID `91848`；receipt/status 最终 `state=exited`、`exitCode=0`、`sawTurnCompleted=true`。
- 结构化事件类型：`runner.controller.started`、`runner.process.started`、`thread.started`、`turn.started`、`item.completed`、`turn.completed`、`runner.process.exited`。
- receipt SHA-256：`e375b877047efeb3f3447820a7505a24213f75988076b697cc7cde0634e6d0d7`；events SHA-256：`5cef9054e75bf84c0acb4775472aa8b0bbe550eee6d059f37826832a2b109a73`。
- 收尾时 controller/child 均不存在。

### resume + cancel

- resume 复用同一真实 Codex thread；controller PID `60508`、child PID `99652` 在 cancel 前均为 alive。
- 只写一次 cancel marker；controller receipt/status 最终均为 `state=cancelled`，`cancellationRequested=true`，Windows cancellation exit code `1223`。
- 结构化事件类型：`runner.controller.started`、`runner.process.started`、`thread.started`、`turn.started`、`item.completed`、`item.started`、`runner.cancel.requested`、`runner.process.exited`。
- receipt SHA-256：`2efa55d1ad0c7a3ceef8c7a30860fbb5caca1c85cc16c4a07aa3e00518ed6b98`；events SHA-256：`87f7f153bad1297fa1a93a913c6514da519589fdb0c8f04e1614779ae8707727`。
- 收尾时 controller/child 均不存在；未使用模型文本作为完成证据。

## 终态

- 随机 loopback port `50737` listener=0。
- Application lease 目录保留 namespace marker，但 active lease file=0；transaction stage entry=0。
- 四个已记录真实 PID 均不存在。
- probe dirty=0，没有半物化文件；本轮没有取得 materialization marker，因此 `materializationCompleted=false`。
- 最终 run 保留 5 个 `.bak` 作为被工具中断的 Application 写事务现场；没有手工删除、覆盖或伪造 clean。它们只位于 marker-owned 隔离根。

## 已知限制与 backlog

以下项目均为本次授权精简后明确延期，不得从本页其他证据推导为“已验证”：

- 当前工具审核会终止生产 WMI launcher 的 controller；默认 launcher 的 installed happy path 需在不拦截该子进程的环境重验。此次 direct-controller fallback 只证明已安装 controller/Codex/Job Object 链路。
- 完整 installed API/SSE/Panel 的真实 start/resume/cancel/status/events 用户链路未完成；API/SSE 只有 targeted 合同结果，Panel 只有编译/export，没有真实浏览器点击验收。
- installed Application attach 没有走到 materialization proof，故没有真实 materialization marker/hash；只确认中断后 probe tree 未变且 dirty=0。该门禁在 P9/P10 的受控真实环境补验。
- 活跃 task 中停止 daemon/UI、再启动 daemon 并恢复完成的真实链路未执行；startup recovery 已有 transaction 内 focused regression，不能替代真实进程恢复。
- 一次过度并发的 harness 版本在 provider 写 snapshot 时打开第二个 Host，触发 `STATE_CORRUPT` 并被终止；该并发矩阵已从最小 harness 删除，5 个 `.bak` 现场保留，后续 P9 评估并发/恢复。
- 早期失败 run 的 `session show --wait` 在瞬态 non-ok Application response 上显示 `session response is missing session state`；非 wait 查询能返回结构化 failed session。CLI wait 的错误投影列入 P9/P10 backlog。
- `session get/list` 在 pre-reap 与查询之间仍存在极窄的 runner 状态变化窗口；当前查询可能尝试同步 durable state，而 Application query 分支没有写事务。该瞬态 `PORT_FAILURE` 与查询/恢复事务归属统一列入 P9 backlog。
- P5 V2 不再把 legacy `last-message` 自由文本当 analyze completion 输入，因此旧测试伪造 exit/last-message 不会把 inbox 自动转为 proposed。若后续仍需要自动建议，须另定义结构化业务结果合同；本阶段不重新引入 raw 模型文本。
- 真实 provider smoke 发生在最终 environment scrub 与 V2 raw GET hardening 之前；两项最终改动仅有 controller/HTTP focused 证据。按本轮“不循环”约束没有重打 tarball 或再次调用 provider，后续 RC 需用最终候选重验。
- auth、provider 网络、工具审核/批准均可能使真实模型执行失败；每类只允许一次最小重试，后续记录结构化失败，不做循环。
- 模型行为非确定；验收只看结构化 session/controller 状态、event、PID、marker/hash 与清理结果，不断言自由文本。
- 未执行浏览器、全量套件、异常排列组合、长期稳定性、生产升级/回滚或额外安全故障矩阵。
- P6–P8、DSH SessionRunner/发行与 P9 双宿主能力均未实现；本分支没有创建 DSH adapter 或第二套 Session 合同。

上述 backlog 统一留待 P9/P10 再评估；P5 不因代码风格、全量测试或外部工具拦截继续扩张。
