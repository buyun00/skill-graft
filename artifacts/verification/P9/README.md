# P9 双宿主合流与安装态最小互操作证据

## 结论

P9 于 2026-08-25 按协调线程两次明确边界决定，以“最小真实运行优先”的授权精简门禁封口。Local/P5 文档封口以 no-ff merge 合入 DSH/P6-P8 最终头；两个发行在源码树外分别安装，代码/包清单审计确认它们装配同一冻结 Contracts/Application/SessionRunner 公共面。P9 shared 命令的真实接口证据由 Local 安装 CLI 与源码树外安装产物的 DSH composition fallback 完成，后者不是成功的 P9 DSH bundle RPC。Local CLI 与该 DSH composition 分别在自己拥有的 probe 上完成一次 plan/sync/materialization；实际 DSH profile 的 P9 业务 RPC 边界单独列为启动时序限制。

本记录不把授权延期项写成通过：不同 probe 的写仍由 shared `hub-global` 串行；同一 shared probe 没有做跨宿主 sync，也没有声称 planHash、runtime asset 或物化字节一致；跨宿主 lock owner UI 没有实现。原计划中的分片并行、锁 owner 只读投影和宿主中立物化合同列为 P10 前置/backlog，P9 不修改冻结的 P5 shared Contracts/ApplicationTransactionPort。

- P4 基线：`43ac1875ab6a08892f6ce222f95c90011affb619`
- P5 shared/Application/Local：`29ea16e32f95a6cd9e1f31b90d223d6c332cf509` → `d2a96110512114c430f370ae4c21616bb83c1b13` → `eae42d9cb2a7356f8f0b975ab98b4cf357a023ee`
- P5 文档封口：`14f9481bd007589b5c83cd01a73fae9a0f6256b8`
- DSH/P6-P8 最终头：`604da2ffde1ea40b2798d32310710ab6183b7d80`
- P9 no-ff 合流：`e9d044a4d5298fc35b1594d9ea1d5b9f67233e93`；两个最终头均为直接 parent
- 分支：`codex/skill-graft-p9-integration`
- P9 阶段封口：本记录所在提交
- 真实 run-id：`p9-c852220d-2693-426d-afda-10f06f959af1`
- marker-owned 隔离根：`E:\skill-graft-e2e\p9-c852220d-2693-426d-afda-10f06f959af1`
- 机读摘要：[summary.json](./summary.json)
- 后缀原始摘要：隔离根 `logs/p9-suffix-summary.json`；包、profile 日志和失败运行现场不进 Git

## 合流与 scope

P9 分支从精确 DSH 头 `604da2ff` 创建。合流前分别 fetch 精确远端 ref，确认 `origin/codex/skill-graft-dsh-p6-p8` 与起始 HEAD 相同、`origin/codex/skill-graft-local-p5-implementation` 为 `14f9481`，且本地与 origin 均不存在 P9 分支。no-ff merge 只在实施计划发生文档冲突；冲突按两个已封口轨道的事实整合，没有改写任一轨产品实现。

最终 P9 产品范围只新增安装态 cross-host gate 和本证据记录：没有修改 `src/contracts/**`、`src/core/**`、`src/application/**`、`src/local/**`、`src/dsh/**` 或 `packages/host-dsh/**`，也没有建立第二套 shared contract。构建生成的 `web/**` 漂移不进入提交。

## 安装包与运行环境

| 项目 | 结果 |
|---|---|
| Node / npm / pnpm | `v24.15.0` / `11.12.1` / `11.19.0` |
| DSH source | `E:\deepseek-harness-master`，`@deepseek-ai/dsh-root 0.1.0-rc.5`；该目录没有 Git metadata，不能报告源码 SHA |
| Local tgz | `ozdqp-skill-hub-0.1.0.tgz`，1,028,011 bytes，SHA-256 `f9de6ed3433f52671bc5c3fc4dd59a23a3c9c803cf7ba40d45b1024e62c50ee1` |
| DSH tgz | `ozdqp-skill-graft-dsh-0.1.0.tgz`，200,072 bytes，SHA-256 `b65ccdfa3e9d37e9ff6898f728923b977931e26b91c32bfc4769e4db1424f5bf` |
| Local 安装 | `local-app/node_modules/ozdqp-skill-hub`；不含 `src/`；命令直接执行已安装 `dist/control/cli.js` |
| DSH 安装 | 独立 `DSH_HOME/profiles/web/node_modules/@ozdqp/skill-graft-dsh`；不含 `src/`；build manifest 指向 `shared Application.commandBus` 且 `localDependencies=[]` |
| Home 隔离 | Local `local-home` 与 DSH `dsh-home` 不同；shared Hub 只位于 `dsh-home/skill-graft` |

真实门禁先完成 `build:release`、`build:dsh`、Harness build、两次 `npm pack --ignore-scripts` 和两处源码树外安装。P9 最终后缀遵守收敛要求，直接复用上述安装产物，没有再次运行 build/pack/profile 或 Local happy path。

## 执行命令与退出边界

| 命令 | 结果 |
|---|---|
| `npm run build:shared` | exit 0；冻结 shared compile 通过 |
| `npm run build:release` / `npm run build:dsh` | 各 exit 0；随后生成上述两个 tgz |
| Harness `pnpm run build`、profile add、`--dump-config` | exit 0；独立 profile 安装并读取 bundle graph |
| `node --test --test-concurrency=1 test/real/cross-host/p9-installed-interoperability.test.mjs` | prefix 已完成 pack/install/profile readiness、shared replay、两个自有 probe materialization、status/query/session；失败输出人工观察到 DSH composition 的 `LOCK_BUSY/retryable=true`，整体 exit 1 仅因为当时 helper 按 `expectedOk=true` 解释预期拒绝 |
| `node test/real/cross-host/p9-installed-suffix.mjs --run-root E:\skill-graft-e2e\p9-c852220d-2693-426d-afda-10f06f959af1` | exit 0，25.8s；复用外装产物完成 winner/read、future-schema 拒写、恢复和残留检查 |
| 两个 P9 脚本 `node --check`、`summary.json` parse、`git diff --check` | exit 0 |

helper 的关键语义修正是把 DSH command wrapper 的 `expectedOk` 传给 `hostCommand`，busy 调用明确传 `false`。真实运行后，canonical 脚本还只做了测试安全/证据口径 hardening：移除 source/Harness build、改为只读预构建前置，future-state 用 `finally` 恢复，suffix 拒绝 link/junction 逃逸，并把 DSH composition 与人工观察标签写准；这些最终脚本通过 `node --check`，没有再执行真实链路。按“真实接口而非整条测试 exit 0”边界，没有为得到 node:test 绿色重复前置路径。

## 真实 shared 公共面

1. Local 安装 CLI 创建 snapshot A：`sha256:2855110081852edb3c9dc3f6cc066b1641378d09946d0d9da7dc0887c4d4e5e5`；源码树外安装产物的 DSH direct composition 用相同 requestId 调 `createSnapshot` 得到 `meta.replayed=true` 和相同 snapshot，证明两宿主装配消费同一 persistent request ledger。该 fallback 从 Local tgz 的 `dist/dsh` 深导入冻结 DSH composition，并把独立 profile 中安装的 DSH package root 作为 runtime asset 输入；它不是一次成功的 P9 profile RPC。
2. DSH composition fallback 创建 snapshot B：`sha256:8c412d746eb1de1d71bcc0360fa2be427233992ed957afafee91781f344728f6`。
3. installed Local lease manager 固定持有 shared `hub-global` 后，`dsh-p9-installed-direct` composition 的 `setPin` 对 shared-state-only probe 在失败输出中返回 `LOCK_BUSY`、`retryable=true`。这是协调线程已确认成立的人工观察；当次测试在 `hostCommand` 的 expectedOk 断言处退出，未继续执行主脚本紧随其后的 code/bytes assertions。helper 已改为 `expectedOk=false`，但按收敛要求没有重跑前置链路。
4. exit-0 最小后缀不重新制造 busy，也不重新断言失败 envelope；它独立确认 busy requestId 不存在于 ledger/audit，shared probe 全 manifest 与原始提交字节一致。释放锁后，Local `setPin` 成功写入 snapshot B，DSH composition `getPin` 读回同一 requestedSnapshot；该成功写只改 shared state，没有物化 shared probe。
5. shared probe 含 `00 FF 0D 0A 80` 二进制 sentinel；busy 拒绝、成功 pin 与 schema 拒写后均保持字节不变。

该锁证据只证明 Local 安装 adapter 与 DSH composition fallback 共用一个 hub-global lease namespace，以及 DSH composition 的 Application envelope 对竞争进行 fail-closed 投影；它不证明独立 DSH bundle RPC 执行了该命令。由于每个写事务当前都先拿 hub-global，它也不能证明 pathKey 锁被触达、两个真实 sync 同时进入临界区，或不同 probe 真并行。

## schema/version skew

最小后缀把 state 临时精确写为以下 45 个 UTF-8 字节（含末尾换行），只做一次真实兼容/拒绝边界：

```json
{"schemaVersion":3,"future":{"opaque":true}}
```

- DSH installed direct composition 的 `inspectSchema` 返回 `status=unsupported`、`detectedSchemaVersion=3`、`currentSchemaVersion=2`、`stateRevision=null`、`writable=false`、`migrationRequired=false`。
- Local 已安装 CLI 的真实 `snapshot create` 写命令返回 `STATE_VERSION_UNSUPPORTED`、`retryable=false`。
- future state 原始 Buffer、ledger、audit、snapshot library、Local probe、DSH probe 和 shared probe 在拒写前后完全相同；随后逐字节恢复当前 v2 state。
- 恢复后 Local `inspect-schema` 为 `current`，DSH composition `status` 为 `ok=true`。

| durable 面 | 当前门禁 | future/unsupported 边界 |
|---|---|---|
| Hub state v2 | Local CLI / DSH composition fallback 共同读写 | v3 可 inspect、不可写 |
| snapshot/pin | 同一 library 与 state truth | future state 下写 fail closed，被检查的持久面不变 |
| request ledger/audit | 相同 requestId 跨 composition replay | 拒写不发布 ledger/audit |
| lease | shared hub-global namespace | busy 人工观察为 retryable；后缀核对 requestId 未进 ledger/audit 且 shared probe 工作树字节未变 |
| SessionRunner public view | 同一冻结 Session contract | 本轮不增加 schema 或第二套状态机 |

## Local 与 DSH composition 各自的物化与会话

- Local 对 `local-owned` probe 完成 plan/sync，planHash `sha256:c700a4510d7474ec5ef3c0101fd409b6737eb2966e8672a4d9d35c9d4de3763f`，materializationId `sha256:c10c165c2dc111c8369126eb77c01d1da4480d0d6cb70556a010c63196ca3eba`，Session 终态 `completed`。
- 上述安装产物 DSH direct composition 对 `dsh-owned` probe 完成 plan/sync，planHash `sha256:9bdac8f2f194c0a0dc86cf839c126387d5641b27baa0c9c1871a761263453a21`，materializationId `sha256:d9d87b05278fed72d8ab192e9f6de405db74d45e0a066d8590b2f0fc2f27f229`，attach Session 终态 `completed`；另有一次公开 chat query 保持 `queued`。
- 两边都读取同一 snapshot A、shared state 和 Application command envelope，但 runtime asset closure 不同，因此 planHash 不相等是已知真实语义；本轮没有跨宿主 sync 任一相同 probe，也不把两值规范化成相等。
- Local `status/listWorktrees/session show` 与 DSH composition `status/listSkills/getSession/getPin` 各完成一次安装态 happy path；公开 SessionView 未泄漏 PID、argv、ownerToken 或原始 worktree locator。后者不得写成 P9 DSH bundle RPC happy path。

两边 attach 的 Application、durable repository、claim、pin/plan/sync、materializer 和真实文件系统路径均为安装产物；只有 SessionRunner 模型执行 seam 使用可控 `SuccessfulLocalRunner` / `SuccessfulDshDriver` 夹具。本轮没有重复调用真实 Codex provider 或 DSH provider；真实 Local SessionRunner 证据沿用 P5，真实 DSH AgentLoop/RPC 证据沿用 P8。

## DSH profile 启动时序限制

DSH tgz 已真实装入独立 profile，`dump-config` 读到插件与 connection，profile 绑定 `127.0.0.1:49214` 并达到 TCP/Web readiness。此前同一 profile/RPC readiness 的业务 `status` 已连续两次得到空响应；按协调线程收敛决定，本候选不再增加业务 RPC 重试，记录为 P9 启动时序限制。P9 的 DSH Application status/query/shared-state 证据改由源码树外安装产物 direct composition 完成：composition 模块来自 Local tgz 的 `dist/dsh`，runtime asset packageRoot 来自独立 profile 安装的 DSH tgz。P8 已验证的真实 DSH RPC transport 作为 transport 既有证据复用，不能把本节写成 P9 live RPC status 或 P9 DSH bundle RPC 成功。

最终 profile 进程已停止，49214 listener 为零。P9 不启动、不依赖 18765 Local daemon。

## 收尾与保护

- 候选 run 的 external lease `leases/`、shared `.skill-graft-transactions` 及三个 probe 的 Git transaction 目录均为空。
- 提交前终端人工盘点确认所有 P9 run-id 的 node/cmd/dsh/pnpm 自有进程为零，候选端口 49214 listener 为零；这一 all-run 结论不是 suffix 内部断言。
- 早期失败或被中断的四个 marker-owned run 根只遗留已过期 lease record；提交前用已安装 lease manager 验证 P9 marker、接管过期 hub lease、回收 orphan worktree lease 后释放，再由终端只读横扫确认全部 P9 run 的 lease entry 为零。运行根和失败证据没有删除；这一 all-run 横扫也不冒充候选 suffix 自身断言。
- run 根 `E:\skill-graft-e2e\p9-*` 与当前 source、DSH source、P5/P6-P8/aa1d worktree 及所有 OZDQP 活工作树均不重叠；测试在任何业务/探针写入前逐项执行 containment gate。候选准备阶段曾在无 Git metadata 的 Harness 目录执行一次 `pnpm run build`，因此不声称该目录构建产物逐字节未变；最终提交的 canonical P9 script 已移除 source/Harness build，只把预构建 Local/DSH stage 与现有 Harness CLI 当只读前置。没有对受保护分支执行 switch、commit 或 push。
- 没有运行默认全量套件、故障注入、kill/recovery、性能、长期运行或排列组合矩阵。

## 已知限制 / P10 前置 backlog

以下三项由协调线程明确列为 P10 前置；P9 不提前改 frozen shared：

1. 不同 probe 真并行需要分片 transaction/ledger/WAL 与对应 revision/恢复语义；当前 shared `hub-global` 会串行所有写。
2. 跨宿主 lock owner 的安全只读投影和 UI；当前只返回结构化 `LOCK_BUSY/retryable`，不展示另一个宿主 owner。
3. 宿主中立 runtime asset/marker/planHash/materialization 合同；当前 Local/DSH runtime asset 字节集不同，不能在同一 probe 上声称跨宿主 plan/hash/物化一致。

另外，P9 profile 在 Web readiness 后的业务 RPC 空响应是已记录启动时序限制；完整真实双 sync 临界区、崩溃接管、schema 双向/多版本矩阵、真实 provider、浏览器、发布安装/卸载/升级/回滚与 registry-only 依赖闭包均未验证。P10 未开始。
