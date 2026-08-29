# P4 daemon protocol D0 protocol-core checkpoint

## 结论

2026-08-24，P4 lifecycle A/B 与 daemon protocol D0 的交界合同完成一个只读可追溯 checkpoint。D0 已建立单一 v1 daemon authority、严格 schema、durable namespace/stage/publication 原语、结构分类器与 frozen inspection proof；focused D0 回归为 198/198，P4 lifecycle 的 daemon residue fail-closed 回归为 2/2，构建通过。

这是 **protocol-core checkpoint**，不是 P4 完成记录，也不是真实 daemon 验收。现有 `run/start/status/stop/doctor/server health` 生产路径没有切换到本协议。

## 冻结文件

| 文件 | Git blob | SHA-256 |
|---|---|---|
| `src/control/daemon-protocol.ts` | `d8158deb995f93699c89a59d17ebabc7abcc8ebf` | `26532177caf429ad534117eee6da40e8a15e36b68da33c186698c2275bde9b44` |
| `test/p4-daemon-protocol-d0.test.mjs` | `bd6a6a9e23e5bb1a2cca05bb8e24a79d0b0df447` | `f7edc4c6c0ca416460c250f77021bbf8d597a98a367891902840c39ddb865e21` |
| `src/control/install.ts` | `74354153cb987cc4ea17e34cdc56ade98d043999` | `9b6ff691288b463c18359926c4c8ff3f8e82ba4f4ae67befe116a75099a92cdf` |
| `src/local/lifecycle/install-domain.ts` | `c6a9fd842316e9e8d5bac3a197715ea2fc74d9d4` | `2fac1a267936b0c9a47881c4c4a437a86c9ca910dd27f038bbd5c0dc59b98f25` |
| `test/p4-lifecycle-contract.test.mjs` | `e86410c6ad112379e8b5cb7995d6282fa218faa7` | `a05593eda3dda44213f3f1c0d3602b0cc799036d3fcbf5229c92d0707f3328d6` |

以上 Git blob 已写入本地 object database；工作树 SHA-256 间隔 2 秒复读一致。

## 验证结果

| 验证 | 结果 |
|---|---|
| `node --test --test-concurrency=1 test/p4-daemon-protocol-d0.test.mjs` | 198/198 pass，0 fail，0 skip；`80319.9868ms`（80.320s） |
| P4 lifecycle daemon residue focused | 2/2 pass，0 fail，0 skip；27.097s |
| `npm run build` | pass；`clean-dist` 后 `tsc -p tsconfig.json` 成功 |
| 运行后检查 | 无残留 D0/P4 test 进程 |

P4 的两条交界回归分别证明：无 HOME authority 的 foreign `${dataRoot}.daemon-instance-stages`，以及 canonical daemon HOME marker + stage + inner marker，都会在 purge 首次 protocol/data mutation 前 fail-closed；receipt、root、owner/WAL、foreign inode/bytes/inventory 与 host writes 均保持不变。

## 已冻结的主要不变量

- HOME receipt namespace 使用独立的 `.daemon-stage-namespace-v1.<uuid>.marker`；same-volume stage sibling 为 `${dataRoot}.daemon-instance-stages`，内部 marker 为 `.namespace-v1.<id>.skill-graft.marker`，最终 authority 为 `skill-review/daemon-instance-v1.json`。daemon marker 不复用 lifecycle owner-stage marker。
- instance、START、STOP、LEGACY 记录和 reservation basename 都使用 exact、bounded、canonical schema；UUID、digest、receipt/install/data/package、actor/target、process identity、PGID、端口、时间与 file/root identities 必须交叉绑定。
- START reservation 在 manifest durable 前不得出现 public/final authority。内部固定五项为 instance、三份 immutable compatibility projection 与 stage manifest；public publication 顺序固定为 `daemon.pid` → `api.pid` → heartbeat → final。
- exclusive writer、hardlink publication 与 exact unlink 采用 no-replace、file fsync、exact readback、parent fsync；每个 checkpoint 后在下一 mutation 前重验全局 receipt/root/stage/projection epoch，不以 fresh capture 洗白 same-byte/new-inode replacement。
- frozen inspector 区分 14 个 structural kind；`INVALID` 仅可报告，不能成为 mutation authority。inspection proof 持续冻结 receipt、ancestor/root、stage/reservation、fixed public paths 与 present/absent topology。
- recovery 会先把 frozen complete START stage 的五个文件与 reservation directory 补齐 durability barrier，再允许首个 public hardlink；LINKED slot 必须先 settle 为 PUBLISHED，才能发布下一 projection/final。
- `skill-review` 只冻结目录 identity 与四个固定 daemon paths；超过 10,000 个无关业务 child 或普通业务 child 变化不会被错误纳入 daemon authority。

## Durability 与 topology cut 矩阵摘要

| 矩阵 | 覆盖 |
|---|---|
| Namespace bootstrap | ABSENT 与 7 种 canonical LEGACY subset；HOME marker 的 created/written/file-fsynced/readback/parent-fsynced/authority cuts，stage directory 的 created/parent-fsynced cuts，inner marker 同系列 cuts；另含 existing-stage parent-fsync recovery |
| START stage | reservation directory 两个 cuts；5 个 logical payload × created/written/file-fsynced/parent-fsynced；只有最后一个 writer 可 opaque，全部 predecessor 必须 canonical durable |
| Durability barrier | manifest written/file-fsynced/parent-fsynced restart；五个 frozen file fsync cuts与 reservation-directory fsync cut可重入；staged-file/reservation same-byte replacement 在 publication 前拒绝并保留 |
| Hardlink publication | projection/final × hardlink-created/parent-fsynced 的 same-process 与 fresh-inspection recovery；source/target replacement拒绝；direct-next/final 先 settle 唯一 LINKED predecessor |
| Structural classifier | 14-kind table；RUNNING 的 16 种 internal alias original-or-absent topology、manifest-last/empty-reservation cuts；STOP/LEGACY partial 与 complete、public subset、missing-path reappearance及语义/identity tamper |
| Canonical与隔离 | schema mutation、malformed/noncanonical/oversize、receipt/HOME/daemon marker/dataRoot/review/stage/inner/reservation/fixed legacy replacement；10,001 个无关 review children；P4 daemon residue 两种首写前 fail-closed |

## 阶段边界与明确非声明

- 本 checkpoint 没有把 daemon protocol 接入生产 `run/start/status/stop`，也没有改变 `doctor`、HTTP server health、daemon API、panel 或自启动路径。
- D1 在任何生产接线、startup authority 释放或“durable start 完成”声明前，必须实现 STARTING-PARTIAL 的 actor-dead exact cleanup/recovery，以及 RUNNING-LINKED/RUNNING-COLLAPSING 的 restart rehydrate、四个 internal alias original-or-absent collapse、manifest-last、directory fsync/readback 与对应 kill-cut orchestration。
- D2 才实现 STOP/LEGACY 的 controller/target process-tree 复核、signal/delete、stage retirement 与 durable recovery；D0 对这些形态只提供严格 schema、分类和 frozen proof，不授权实际 mutation。
- 本轮没有执行源码树外安装、真实 daemon/API/端口、浏览器、setup/doctor、升级/卸载或真实进程 signal 验收，因此不能据此声明 P4 完成或本地发行可用。
