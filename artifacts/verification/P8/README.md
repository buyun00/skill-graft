# P8 DSH SessionRunner 与 attach/resume 最小真实门禁证据

## 结论

P8 于 2026-08-25 按用户明确授权的“最小真实运行优先”例外封口：DSH bundle 以进程内 `AgentRegistry`/`AgentLoop` 实现冻结的五方法 SessionRunner 合同，settings 无父入口和已有对话 live-parent 入口均进入共享 `HubApplication`。证据分为两层：真实 DSH AgentLoop + MockAdapter 覆盖 native start/resume/cancel；可控 fake driver + 真实 Application/文件系统覆盖 attach→claim→pin/plan/sync→materialization。隔离 profile 的 live parent 路由真实运行，但没有可用联网 provider，不能把这两层合称为真实 provider attach 成功。全程没有调用外置 `sg`、Local daemon、Codex runner，也没有修改 Local 专属实现。

- P4 基线：`43ac1875ab6a08892f6ce222f95c90011affb619`
- P6 封口：`51c0743ee6ba61488e3ae8893d1a8ce857856763`
- P7 封口：`65bc74c9d7b1353ac5fcca7fb53b39dba163de9e`
- 分支：`codex/skill-graft-dsh-p6-p8`
- 阶段封口：本记录所在提交
- DSH 源码：`E:\deepseek-harness-master`，`@deepseek-ai/dsh-root 0.1.0-rc.5`
- 隔离运行：`P6-real/20260825T110830` 的独立 `DSH_HOME`
- 共享基线 ancestors：`29ea16e32f95a6cd9e1f31b90d223d6c332cf509` → `d2a96110512114c430f370ae4c21616bb83c1b13` → `eae42d9cb2a7356f8f0b975ab98b4cf357a023ee`
- 未合入：P5 文档封口 `14f9481bd007589b5c83cd01a73fae9a0f6256b8`，按协调要求留给 P9 历史/文档合流

## 实现与安全边界

- `src/dsh` 持有 DSH 专属 binding、durable session repository、runner adapter 与 runtime；状态保存在 DSH data root 的 `dsh-sessions.json` 和按 attempt 分隔的 binding 文件中。
- `packages/host-dsh` 持有 `AgentHandle`，用 DSH `SessionStore`/JSONL 恢复 continuation；Host dispose 取消并释放自己拥有的 active handle，但不在 Application 写事务外伪造持久状态。
- Runner 公开面只有 `start/resume/cancel/status/events`；公开 SessionView 不含 PID、path、argv、Codex 或 PowerShell，跨层只传 opaque ID、归一状态、错误和有界事件。
- 所有 DSH start/resume 固定异步；`wait` 不会占住 Application durable write transaction。完成、失败、取消或宿主重启后的 lost 由显式 `reapSessions` 写命令折叠。
- worktree CWD 必须是存在的 canonical 绝对目录；相对 worktree 和越出 canonical Hub root 的 Skill locator 在 DSH 启动前 fail-closed。
- resume 启动失败保留上一轮 runner/continuation，允许再次 resume；driver 若报告 `succeeded` 但 exit code 非零，统一变为 `failed/RUNNER_PROTOCOL_ERROR`。

## 自动化最小门禁

| 验证 | 结果 |
|---|---|
| `npm run build` | exit 0；完整 TypeScript compile |
| shared compile/contract focused | `npm run build:shared` exit 0；P5 contract、shared boundary、package contract 12/12 pass |
| `npm run build:dsh` | exit 0；production Host/Client bundle |
| P8 production + restart/resume/cancel/error focused | 2/2 pass；相对 CWD 拒绝、resume 首次启动失败可重试、非零“成功”归一失败、query 无越权写入 |
| P8 Application attach focused | 1/1 pass，98.4s；runner→awaiting→claim→plan→sync→materialization→completed |
| `npm run test:real:dsh:p8:agent` | 1/1 pass，1.20s；真实 DSH `AgentRegistry + AgentLoop + JSONL + MockAdapter` start/resume/cancel |
| P6/P7 focused 回归 | 各 2/2 pass；独立 bundle/RPC 与 workspace/Skill 生命周期保持 |
| shared source working diff | `src/contracts/**`、`src/core/**`、`src/application/**`、`src/local/**` 与 Local package 均为零 |
| ancestor 核对 | `29ea16e3`、`d2a9611`、`eae42d9` 均 exit 0；`14f9481` 非 ancestor |

没有运行默认超长全量套件或故障排列组合；范围化用例只覆盖公开接口各一次 happy path 与必要写入/失败边界。

## 最终发行包

最终 production bundle 经 `npm pack --dry-run --json --ignore-scripts`：

- 文件数：7
- package：200022 bytes
- unpacked：1099575 bytes
- SHA-1：`7089d4a6bf710ebcda6ebb0c45116b0761035e6c`
- integrity：`sha512-IgD8qEFZxk7mLswWo/O/4BFozLD4p/1Gqh32KvFdobQ1qZZ6lQu7+y7gNumm0VNz7LDzX/mErJZs0ClapeGG9w==`
- Host/Client bundle 不含 `127.0.0.1:18765` 或 Local Codex session runner；DSH-native agent/session/tool peer 服务由 profile 注入。

最终 tgz 在隔离 `DSH_HOME` 执行 `plugin --profile web remove/add` 均 exit 0。add 报告 DSH peer warning；同一 profile 的 bundle graph 已提供这些服务并成功启动，清洁 registry-only 依赖闭包留给 P10 发布候选门禁。

## 真实 DSH profile 与入口

1. 最终 candidate 在 `127.0.0.1:61456` 启动；第一次 POST 早于 Connection route 挂载而返回 405，按门禁一次最小重试后 `status` RPC 返回 `ok=true`、`meta.handler=application.commandBus`，并读取同一隔离 data root。
2. settings/RPC 无父入口发起 `chat`：真实 DSH `AgentRegistry.create()` 返回 opaque runner，Application 立即记录 `running`，没有伪造 parent。
3. 以该 runner 对应的真实 live `AgentHandle` 调 `/skill-graft/execute-from-session`：wire 和 Application 均 `ok=true`，`listSessions` 返回 2 个会话，handler 仍为 `application.commandBus`。不存在或空 parent 会被 Host 拒绝。
4. profile 重启前后的旧 active attempt 经显式 reap 从 running 收敛为 `failed/RUNNER_NOT_FOUND`，保留 continuation 并允许 resume；resume 创建新 attempt 且复用 opaque runner identity。
5. 最终 profile 正常停止，61456 listener 已释放；真实 AgentLoop smoke 生成的两个临时 DSH test 文件均在 finally 中删除。

## attach、续跑与取消证据边界

- Application attach focused 使用真实临时 Git worktree、snapshot repository、shared claim/plan/sync/materializer 和 DSH Host composition；只有模型执行 seam 使用可控 fake driver。最终状态为 completed，materialized marker 与 Skill 内容真实落盘，公开 SessionView 未泄漏 worktree/path/PID/argv/Codex/PowerShell。
- DSH source smoke 不是重写的 runner：它把发行包的 `agent-driver.ts` 临时放入 DSH 自有 AgentLoop test graph，直接使用真实 `AgentRegistry`、`SessionStore`、JSONL persistence 与 DSH `MockAdapter`，完成 start、dispose/reopen、resume 和 cancel。
- 最终安装 profile 故意选择不存在的 provider/model，因此真实无父 start 与 live-parent 路由可验证，但模型轮次按预期落为 `failed/RUNNER_PROTOCOL_ERROR`；没有将该失败冒充成功回答。

## 已知限制 / backlog

- 本机隔离 profile 没有配置可用联网模型 provider；真实模型成功回答未验证。成功/续跑/取消的当前门禁是 DSH 自带 MockAdapter 上的真实 AgentLoop smoke。
- P8 新增 settings session 控件与 conversation header action 已进入 production Client bundle；P7 页面已做真实浏览器验收，但 P8 新控件未逐项浏览器点击，最终入口以真实 RPC/live parent 取证。
- profile 重启后 durable active session 需要一次显式 `reapSessions` 才从旧 running 折叠为 lost/failed；这是当前恢复边界，不是自动启动写入。
- add 的 peer warning、clean registry-only install、真实 provider、HMR、长期运行、多 profile 并发、网络/权限故障矩阵与双宿主锁竞争进入 P9/P10；本阶段不为自动化假绿扩张产品。
