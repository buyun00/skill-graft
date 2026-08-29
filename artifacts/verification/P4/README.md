# P4 Local 发行与独立核心真实环境证据

## 结论

P4 于 2026-08-25 按用户授权的“最小真实运行优先”完成封口。最终候选的 Local composition、CLI/API/SSE/panel、setup/doctor/hooks、canonical release 和源码树外 tarball 已通过候选自动化门禁；源码树外 real run 真实覆盖了 CLI、API-backed panel、setup/doctor/hooks，以及 `sync`、dirty conflict、uninstall 与 purge 的一次 happy path 或必要拒绝边界。SSE 本轮只保留自动化合同结果，不写成独立 real smoke。

本记录不把 focused/mocked matrix 冒充真实验收，也不把未在最终候选重跑的 switched-WAL、kill-cut、异常恢复、并发或长期稳定性写成已验证。完整延期项见“精简验收与延期清单”。

- 基线 SHA：`b89832ecdb1ef3e5423795c55717b1ff443aab53`
- 分支：`codex/skill-graft-dual-host`
- 验收实现 / 已核对远端 SHA：`64875fe442594c9e02c3384caf7d3555701446ee`
- 最终 real run-id：`p4-local-20260824-1f25d6a4`
- 隔离根：`E:\skill-graft-e2e\p4-local-20260824-1f25d6a4`
- release buildId：`p4-1766a529a66d60a322ca69973f6faeec`
- 阶段封口：本记录所在提交
- 原始 tgz、运行态、浏览器握手和失败现场只保留在 marker-owned 隔离根；仓内不提交会话全文、prompt、history、凭据、私有 Skill 或运行态 JSON

## 验收环境

| 组件 | 版本 / 使用边界 |
|---|---|
| Windows | `Microsoft Windows NT 10.0.26200.0` |
| Node.js | portable `v24.16.0`；setup 烘焙的 `nodePath` 与 real runner 一致 |
| npm | `11.13.0` |
| Git | `2.49.0.windows.1` |
| pnpm | `11.19.0`；本轮 Local real run 未调用 |
| DeepSeek Harness | 源包 `0.1.0-rc.5`；P4 未启动 DSH，`dshUnused=true` |

## 自动化候选门禁

| 验证 | 结果 |
|---|---|
| 最终默认套件 `npm test` | exit 0；1247 total / 1245 pass / 0 fail / 2 skip；`6647153.3176ms` |
| `npm run build:release` | pass；buildId `p4-1766a529a66d60a322ca69973f6faeec`；8 HTML / 38 canonical web files |
| `npm run verify:release` | pass |
| `npm run test:safety` | 32 total / 31 pass / 0 fail / 1 skip；`191876.4618ms` |
| `npm pack --dry-run --json --ignore-scripts` | pass；239 files；987771 bytes；SHA-1 `99830c9690d3ff2209a0e27380cecaa319c69485` |
| typecheck / focused / whitespace | 最终候选前的 `tsc --noEmit`、受影响 focused 与 `git diff --check` 均通过 |

默认套件全绿后没有第三轮默认套件；用户收敛指令生效后也没有重跑 protocol、fault-injection、performance 或 safety 矩阵。

## 源码树外候选包

| 字段 | tarball A | tarball B |
|---|---|---|
| 版本 | `0.1.0` | `0.1.1-p4.28e26ce4` |
| 文件 | `ozdqp-skill-hub-0.1.0.tgz` | `ozdqp-skill-hub-0.1.1-p4.28e26ce4.tgz` |
| files / unpacked | 239 / 4010342 bytes | 240 / 4010558 bytes |
| tgz bytes | 987771 | 987983 |
| SHA-1 | `99830c9690d3ff2209a0e27380cecaa319c69485` | `168a12b7d36718fae4c472c19a75aaf20ae4b95a` |
| SHA-256 | `dd0c881665de297a56244469a7d780ce031e16ac6168269ef715f001fcda6f5a` | `73332e5b18478fad3949d69dc5205c5c90d6dbcf74ce8fef5aede6b1715a5884` |
| integrity | `sha512-2lTDooJKXXsJnYcBFtEJ0lakb4UlMn3Z31BbWuHB8+5d5pcbtKjRM+5DJHTi/Wn1KQhsZ4JbSUqzi1YpcOCXfw==` | `sha512-pWgiUb33mWnSSAN1FZ1PVj4Pm+5xaZTmuJEfrXqSpgq+ZT/LGlOawqWEtIQGT0JvvpCyXIGjGzrVkSiTfojKnw==` |

两包均安装在源码树外。B 是 P4 接口 smoke 的第二 tarball，不是 P10 release candidate。`privateCorpusShipped=false`；包内 `skills/` 只有公开 `README.md`，私有/用户 Skill corpus 不进包、不进提交。

## 真实 Local 接口 smoke

### A 安装、doctor、hook 与 daemon

基线保护包装器先以 compare-exchange 精确暂时剥离已知全局 PATH/环境入口，结束时按原字节与 registry kind 恢复。A 的真实流程越过源码树外安装、setup replay、strict doctor、新 shell、随机端口 daemon、snapshot、state migration、post-checkout hook 与 worktree claim，随后生成 panel ready。

P4 只把 hook 记作 SessionStart compatibility：会话到达旧兼容 `waiting/exitCode=0` 并完成 claim 前置；`p5RunnerAcceptance=false`，不宣称 P5 真实 Codex Runner/attach。

### 浏览器 plan / sync / materialized / history

- in-app browser 打开 `http://127.0.0.1:52217/workspaces`，真实读取并选择 `probe/p4-worktree`。
- 初始 Pin 为 `claimState=claimed`、requested snapshot A、materialized 空。
- snapshot A：`sha256:224d2a00697c7a12978da9ca32c5cce641c7a7f701ae44af7f50139668053412`。
- `预览计划` 返回 `planned / executable`，planHash `sha256:06684f83919ce67c526f4aa06d68dc4e4e07814031a81d90fe34567582e9d5e3`。
- 浏览器只点击一次 `执行 sync`；完成后 Pin 回读为 snapshot A，history 出现 `worktree.materialized` 与 `command.succeeded`。
- materialized private Skill 为 69 bytes，SHA-256 `7edd07beab0d957442d0aa1b738f49769d8eacf044a4c5631b8f117260a04f1c`，与 data-root 源字节一致。
- plan-sync ready：455 bytes，SHA-256 `d0d029a1db343745d423a805d6a3106580af48a08e1a625aacac028641a1ae73`。
- plan-sync continue：105 bytes，SHA-256 `4da44116c60b6900d7e3356ed8e0a252e9b38bdbbc71503dd2a82b43b6ca5455`。

### B 包读取原数据与 dirty 边界

浏览器 continue 后，产品 ledger 已把 snapshot B、setPin 与 sync B 记为 completed；harness 随后在响应/收尾阶段以 `TimeoutError` 结束，没有生成 stage-2 ready 或最终 summary。该失败根保留，未重跑完整 installed-real。

按用户授权，后续只用已安装 B 包的真实 CLI 完成同接口 smoke：

- B CLI 版本 `0.1.1-p4.28e26ce4`；`pin show` exit 0，成功读取 A 留存的数据。
- snapshot B：`sha256:523c10fc24a27e3a8f4180fbe2d779e2d9c2b85df969d8dff43da896343d8cbe`。
- requested/materialized 均为 snapshot B，`claimState=claimed`，selected Skill 为 `p4-private-skill`；materialization B 为 `sha256:8154d18089e5adca6c912da5f533dc5908872912d86be4754507e9e823496688`。
- 在当前 run-id probe 内只改受管 `AGENTS.override.md` 的首行制造 dirty；B `plan-sync` exit 0，返回 `status=conflict`、`executable=false`、唯一 conflict `kind=dirty`。
- dirty planHash：`sha256:c03747e73463345da4bf0dd179df27834d8186241707be5b9e10e84b25950fa2`。
- dirty 文件 SHA-256 在 plan 前后均为 `35f2c2c8763579aa6315f11b039de52e27d28720c6496d609e54d6d7513ed849`，证明 plan 没有覆盖文件；随后只恢复本轮改动的首行。

浏览器 stage 2 的 DOM 自动步骤因此记为“工具侧未验证/需后续人工复核”；同一 B 产品接口的真实 CLI conflict/no-overwrite 结果作为本阶段授权 smoke 证据。

## B 独立 setup / uninstall / purge

在同一 run-id 的 `logs/p4-minimal-b-smoke` 下创建完全独立的 HOME/data/install/task/port/DSH_HOME，CLI 位于要删除的 installDir 之外：

1. B `setup --no-daemon --no-path --no-task --json` exit 0；package/lifecycle version 为 `0.1.1-p4.28e26ce4`，doctor ownership/versionMatch/lock 均正常，随机端口 `57934` 从未启动 listener。
2. 第一次 uninstall 对人为放入 data-root 顶层的未知 sentinel fail-closed，install/data/marker 均未改变；这是本轮唯一删除边界拒绝。该单文件由本轮创建，随后精确删除。
3. 唯一 happy-path uninstall exit 0、`status=uninstalled`、`filesRemoved=true`；installDir 消失，Hub data 与 inactive marker 保留，`activeInstallId=null`。
4. purge dry-run 返回 `planned`，dataRootId `4f0ac3f5-e1ff-4e73-9b2c-5c42f8d81f23`，planHash `sha256:66c057e6e26fc0a45ac7c57993b77d39108579db2d8a27a1665bd19b5fcf3512`。
5. 同一 plan 的 commit exit 0、`status=purged`；独立 dataRoot、receipt、lifecycle lock 与 WAL 均不存在，application leases 为空，隔离 DSH_HOME 为空。

主 run 证明已安装 B 包的 CLI 可真实启动并读取 A 留存数据；独立 `p4-minimal-b-smoke` 只证明 B 自身 lifecycle 的 setup/uninstall/purge happy path，且没有启动 daemon。最终精简 run 没有执行 A→B `upgrade` 命令或升级恢复矩阵，不能把这两组证据合并成升级验收。

## 终态与提交范围

- HKCU User Path SHA-256 恢复为已知基线 `016e94da69a8cdd083c935014db78373d92a33459d1f512b64095caa06ae434b`，且不含本 run-id。
- `SKILL_GRAFT_HOME`、`HUB_ROOT`、`HUB_API_PORT` 分别恢复为原值及 `ExpandString / String / String` registry kind。
- 本 run-id 相关进程为 0，端口 `52217` 与 `57934` listener 为 0，两个测试任务均不存在。
- 主验收 data root 与 private Skill 保留；独立 purge 根已删除。
- implementation commit 含 159 个 Git diff 路径；范围审计确认没有 `skills/**` 私有 corpus、`skill-review` 运行态、`.artifacts-local`、`dist`、`node_modules`、tgz、docs 或 verification artifact。
- `origin/codex/skill-graft-dual-host` 已由 `git ls-remote` 核对为 `64875fe442594c9e02c3384caf7d3555701446ee`；implementation push 后 `HEAD...@{upstream}=0/0`。

## 精简验收与延期清单

本节是用户在 P4 封口前明确授权的验收边界：每个公开接口以一次真实 happy path 和必要写入边界为准，额外质量矩阵统一进入 backlog。

- 已验证：Local 页面读取、plan、一次 sync、materialized Pin、history；B CLI 读旧数据；dirty conflict/no-overwrite；独立 B setup/uninstall/purge；终态 process/port/task/HKCU 边界。
- 未自动完成：浏览器 stage 2 的 conflict DOM/disabled button；原因是 harness 在生成第二 ready 前 Timeout。真实 B CLI 已覆盖同一业务接口，但 UI 仍需后续人工复核。
- 未单独真实执行：installed external run 的 session SSE/EventSource；候选自动化合同通过，但不计作 real smoke，留待后续真实 SessionRunner 用户路径复核。
- harness 没有生成最终 summary，因此本记录不声称取得完整保护根前后 fingerprint receipt；已确认本轮操作只落在指定 checkout、run-id 根与明确系统集成项，提交范围另经 Git 审计。
- 最终候选未重跑：switched-WAL、kill-cut、升级失败回滚、恢复重放、并发、性能、长期稳定性或额外异常矩阵。
- P9 backlog：双宿主并发、schema mismatch/coexistence、resource-keyed scheduling 与相应恢复。
- P10 backlog：双发行 RC、完整升级/降级/失败回滚矩阵、发布候选长期验收与远端默认分支门禁。
- P5 未开始：没有真实 Codex SessionRunner attach/resume/cancel；P4 hook 兼容不能替代 P5。
- P6–P8 未开始：本轮没有使用 DSH、pnpm profile 或 DSH_HOME 宿主能力；`dshUnused=true`。
- 当前 P4 范围内“未执行”即以上明确列项；不再以 focused/mock 数量替代真实验收。

## 中间 checkpoint

- [D0 protocol-core](./daemon-protocol-d0.md)
- [D1-A low-level mutation closure](./daemon-protocol-d1a.md)
- [D2 control-mutation](./daemon-protocol-d2.md)

这些文档记录协议演进时点的对象与自动化证据，不单独代表 P4 完成，也不扩大本 README 的最终真实验收声明。
