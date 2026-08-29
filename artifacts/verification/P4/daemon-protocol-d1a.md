# P4 daemon protocol D1-A low-level mutation closure checkpoint

## 结论

2026-08-24，daemon protocol 在 D0 protocol-core 之上完成 D1-A 的**低层 mutation closure checkpoint**：可对已冻结的 abandoned START 做 actor-gated exact cleanup，也可对已提交的 START authority 做 restart-safe alias collapse。源码与 focused tests 经 exact-object 双审为 GO；构建、D1-A 162 行与当前源码上的 D0 198 行均通过。

这是 P4 进行中的协议证据，不是 production daemon 或 P4 完成记录。现有 `run/start/status/stop/doctor/server health` 生产路径仍未接入这些 API。

## 冻结文件

| 文件 | Git blob | SHA-256 |
|---|---|---|
| `src/control/daemon-protocol.ts` | `2bebe4e6555c6ae60efcbec0c762dbb8b8240f69` | `3f2c3db4e3f0ea0fdaddf514da0e33adb0f590cc2c79602def169b9317097779` |
| `test/p4-daemon-protocol-d1a.test.mjs` | `a6ad15d5cf7c5b23e5154690689ea14c0002e519` | `130ab5bb3352e1cf0bc65ab383da54a9c0f1f26b51b2d940bd1b76b7cc773259` |
| `test/p4-daemon-protocol-d0.test.mjs` | `bd6a6a9e23e5bb1a2cca05bb8e24a79d0b0df447` | `f7edc4c6c0ca416460c250f77021bbf8d597a98a367891902840c39ddb865e21` |

以上 Git blob 已写入本地 object database；工作树 Git blob 与 SHA-256 间隔 2 秒复读一致。运行后无残留 D0/D1-A test 进程。

## 验证结果

| 验证 | 结果 |
|---|---|
| `npm run build` | pass；`clean-dist` 后 `tsc -p tsconfig.json` 成功 |
| `node --test --test-concurrency=1 test/p4-daemon-protocol-d1a.test.mjs` | 162/162 pass，0 fail，0 skip；`108527.3541ms`（108.527s） |
| `node --test --test-concurrency=1 test/p4-daemon-protocol-d0.test.mjs` | 198/198 pass，0 fail，0 skip；`82655.2806ms`（82.655s） |
| scoped diff/whitespace 与运行后进程检查 | pass；无 trailing whitespace，无匹配 Node test 进程 |

## D1-A 已冻结的主要不变量

- Abandoned START cleanup 只接受模块签发、WeakMap 绑定的 `STARTING-PARTIAL | STARTING` frozen authority。trusted probe 只提供 raw `dead | alive(identity, pgid) | unknown` facts；协议自身判定 `dead`、`pid-reused`、`alive-owner` 或 `unknown`。只有 dead 或明确 identity mismatch 的 PID reuse 可以清理；identity 匹配但 PGID 不匹配仍 fail-closed。
- Probe facts 必须是 exact plain/null-prototype record；Array、额外键、非法 identity/PGID、getter/Proxy 异常都不能变成 authority。getter 值只读取一次并规范化为模块私有 frozen plain record。
- START cleanup 固定逆序删除 public heartbeat → API PID → PID，每次把 internal/public R2 pair 显式推进为 internal R1 + target absent；public 全空后删除 manifest，再按 instance → heartbeat → API PID → PID 删除 internal writer prefix；最后只删除 exact empty reservation，保留 HOME daemon marker、stage namespace 与 inner marker。
- Committed START collapse 只接受 frozen `RUNNING-LINKED | RUNNING-COLLAPSING` authority。internal PID → API PID → heartbeat → instance 逐项由 R2 + public/final R2 推进为 internal absent + counterpart R1；manifest 始终最后删除，随后 exact empty reservation rmdir，终态严格为 `RUNNING-CLEAN`。
- Exact unlink/rmdir primitive 在第一次调用时私有 deep-pin file/directory、parent identity 与 durability phase；hook throw 后，同一 authority 或 fresh inspection 只能续原 path/inode 的 REMOVED → parent-fsynced → DURABLE 状态。caller 后改 expected path/bytes/state 无效；file seal callback 只收到独立 defensive clone，不能污染 replay baseline。
- Mutation factory 执行 caller frozen proof → private inspect → caller proof 的同步 sandwich，并对 semantic/proof 做 stable canonical exact signature；options、receipt record、paths、Buffers、states、directories、absences 均进入不外泄的 private clone。每个 checkpoint 与下一 mutation 前重验 receipt/root/stage/review/fixed paths；合法变化只能显式 advance。
- Terminal fresh inspection 使用 old epoch → fresh immediate clone → old epoch sandwich；rmdir 后 fresh `ABSENT | RUNNING-CLEAN` 恢复只补 stage-parent fsync/readback，不从 absence 推断或删除任何其它对象。
- `INVALID`、`STOPPING[-PARTIAL]`、`LEGACY-RETIRING[-PARTIAL]`、`ABSENT`、`RUNNING-CLEAN` 等错误 kind 不能借 D1-A mutation API 写入；caller 构造相同 structural object 或伪改 inspection kind 也无法命中私有 epoch。

## Focused cut 矩阵摘要

| 矩阵 | 覆盖 |
|---|---|
| Partial writer cleanup | 5 个 payload × created/written/file-fsynced/parent-fsynced × dead/pid-reused；每个 logical prefix 的 alive-owner/unknown 全树零写 |
| Complete START cleanup | public prefix 0/1/2/3；三份 public 与五份 internal/manifest removal slot 的 file-unlinked、parent-fsynced cut，均覆盖 same-authority 与 fresh-authority replay；cut 当下显式检查 absent path 与 counterpart R2→R1 |
| Committed collapse | 4 个 internal alias 的 16 种 original-or-absent 起点；每个 alias/manifest unlink 与 parent-fsync 的 same/fresh replay；manifest-last、empty-reservation、rmdir 与 terminal settle |
| Rmdir/primitive retry | abandoned/collapse × directory-removed/parent-fsynced 的 same/fresh recovery；generic file/directory expected mutation、seal callback mutation与后续整函数重放 |
| Replacement/provenance | source、target、manifest、reservation、inner marker、receipt record same-byte/new-inode 或 shared-object drift；caller proof/options/Buffer/state/absence mutation；old→fresh→old stateful reader；manifest cut 后 later-slot replacement |
| Fail-closed kinds | alive/unknown/PGID mismatch、Array facts、forged authority、forged kind、STOP/LEGACY partial、terminal/invalid states均在下一 mutation 前拒绝并保持 whole-tree evidence |

## Fresh opaque 边界

- 对 crash 后首次严格 inspection 之前的不可观察离线重造，本协议不制造递归 self-inode anchor：例如最后一个 opaque partial writer、empty reservation 或 clean final 在首次 capture 前被非协作者同 shape 重造，无法由持久 schema 证明旧 inode。
- 一旦 inspection/factory 已 capture，当前 inode/bytes/root/receipt/topology 即成为 frozen proof；跨任何 probe、checkpoint 或 fresh handoff 的 same-byte/new-inode replacement 都必须 fail-preserve，禁止 fresh rebase。
- 本轮 fresh retry 是新的 strict inspection + authority handoff，不是 numeric PID 猜测；terminal absence recovery只做 durability settle，不授权清理新出现的对象。

## 明确非声明与后续门禁

- 本 checkpoint **没有 production daemon wiring**，没有修改旧 `daemon.ts`、CLI、HTTP、status、doctor、server health 或 panel 生产路径，也没有释放 startup authority。
- 本轮没有真实 host process probe、真实 process tree/PGID/Windows Job 适配、OS signal、独立进程 tree-kill/power-loss 或端口/API epoch 验收；trusted actor probe 仍是注入的测试 port。
- D1-B 仍需完成 production 前的真实 process/listener facts、startup orchestration 与既定运行接线门禁；在此之前不能声称 durable production start。
- D2 才实现 STOP/LEGACY controller/target process-tree 复核、signal/delete、stage retirement 与 durable recovery；D1-A 明确不授权这些 mutation。
- 未执行源码树外安装、真实 daemon/API、setup/doctor、升级/卸载或本地发行真实探针，因此 P4 仍为“进行中”。
