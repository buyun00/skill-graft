# P4 daemon protocol D2 control-mutation checkpoint

## 结论

2026-08-24，daemon protocol 在 D0 protocol-core、D1-A low-level mutation closure 与 D1-B startup orchestration 交界上完成 D2 的纯文件系统控制层：STOP 和 LEGACY-RETIRE 具有独立耐久 stage、私有 signal/retirement provenance、固定删除顺序与 kill-cut 恢复；D0/D1-A/D2 合并 focused 回归为 410/410，构建通过。

这是 **D2 control-mutation checkpoint**，不单独代表 P4 完成。后续 production wiring、源码树外发行与精简真实验收由 [P4 总证据](./README.md) 封口。

## 本次对象快照

| 文件 | Git blob | SHA-256 | 行数 |
|---|---|---:|---:|
| `src/control/daemon-protocol.ts` | `4a9a3ef03e5c6a6c12f7a7dc794af2dfaea733e9` | `87ad228725e13503c8759b300e02a43f727587ae2ca5abd5a65d85125906670c` | 6006 |
| `test/p4-daemon-protocol-d2.test.mjs` | `79a6c1bf73fe23941bd0b01568cf21e7fbed1a55` | `b4951d0e7e110ce9150f937fc7660e64fdc0e3f624040d0fe8b84f05e675779b` | 710 |

以上对象值已在 P4 implementation commit `64875fe442594c9e02c3384caf7d3555701446ee` 上复核，仍与本 checkpoint 精确一致。

## 验证结果

| 验证 | 结果 |
|---|---|
| `npm run build` | pass；`clean-dist` 后 `tsc -p tsconfig.json` 成功 |
| `node --test --test-concurrency=1 test/p4-daemon-protocol-d2.test.mjs` | 50/50 pass，0 fail，0 skip；`50515.5925ms` |
| D0 + D1-A + D2 合并 focused | 410/410 pass，0 fail，0 skip；`552399.2096ms` |

合并 focused 的构成为 D0 198、D1-A 162、D2 50；验证了 D2 新 mutation API 没有回退既有 classifier、START publication/cleanup/collapse 和 terminal settle 合同。

## D2 导出合同

- `createDaemonStopStage`：只从 frozen `RUNNING-CLEAN` 创建 canonical STOP reservation + manifest；支持 exact alive、明确 dead，以及原 PID 已被其它 process identity 复用且 listener absent 三种安全起点。
- `createDaemonLegacyRetireStage`：只从 frozen `LEGACY-NAMESPACE-RECOVERABLE` 创建 LEGACY-RETIRE；legacy 必须在 staging 前取得 exact live process identity、PGID、完整 PID-sorted tree 与 owned listener，缺 identity 一律 fail closed。
- `recoverDaemonControlStage` / `assertDaemonControlStageCurrent`：对完整 STOPPING/LEGACY-RETIRING stage 重做 manifest、reservation 与 stage-parent durability barrier，并只签发 WeakMap-backed stage view。
- `acquireDaemonControlSignalAuthority` / `readDaemonControlSignalTarget`：signal authority 仅在 process PID/identity/PGID/tree 与 listener port/PID/identity 全等时签发；协议只返回 exact signal target，不执行 OS signal。
- `acquireDaemonControlRetirementAuthority` / `retireDaemonControlStage`：只有 target dead，或同 PID 的 observed identity 明确不同，且 exact target listener absent，才签发 retirement authority。
- `acquireAbandonedDaemonControlStageCleanupAuthority` / `cleanupAbandonedDaemonControlStage`：仅凭模块私有 provenance 和原 controller actor dead/PID-reused facts 清理 writer-cut partial reservation；alive-owner、identity-match/PGID drift、unknown 均拒绝。

## 冻结不变量

- Control options、actor、target process/listener facts 和 process-tree entry 必须是 exact plain data records；getter、Proxy、Array/额外键、非 canonical scalar 不能进入 mutation authority。
- STOP target 绑定 immutable final instance、三份 projection identity、epoch、PID/API PID、process identity、PGID、port 和 exact process tree。普通 daemon stop 的 `lifecycleOwnerBinding` 为 `null`；setup/upgrade/uninstall/recover/purge 可携带并冻结 owner record、owner-stage namespace、receipt/install/data-root authority。
- LEGACY projection 只能证明其兼容字段，不能自行证明进程 generation。因此 legacy 在 exact identity 不可观察时不得 staging、signal 或 delete。
- Signal authority 与 retirement authority 分离。live exact target 只能 signal，不能 retire；dead 或 PID-reused + listener absent 只能 retire，不会通过协议层执行 signal。
- Retirement 删除顺序固定为 heartbeat → API PID → PID → final instance（STOP only）→ stage manifest → exact empty reservation rmdir。每个 unlink/rmdir 都包含 checkpoint、parent directory fsync、exact inode/readback 与可重入 WeakMap removal state。
- STOP 删除后为 `ABSENT`；LEGACY-RETIRE 删除后同为 `ABSENT`。HOME daemon authority marker、stage namespace directory 与 inner marker保留，四个 fixed public/final authority path 全空。
- Abandoned STOP creation cleanup 回到 `RUNNING-CLEAN`，abandoned LEGACY creation cleanup 回到 `LEGACY-NAMESPACE-RECOVERABLE`；不能把“controller stage 未完成”误当成“target 可删除”。只有 target 已按 retirement 顺序消失的 terminal partial 才恢复到 `ABSENT`。

## Kill-cut 与 fail-closed 矩阵摘要

| 矩阵 | 覆盖 |
|---|---|
| STOP / LEGACY create | reservation created、stage-parent fsynced、manifest created/written/file-fsynced/parent-fsynced、complete checkpoint；partial actor-dead/PID-reuse cleanup 与 complete recover |
| STOP retirement | review/reservation recovery barriers；heartbeat、API PID、PID、final、manifest 的 unlink + parent-fsync；reservation rmdir + parent-fsync；每个 cut 用 fresh inspection 幂等收敛 |
| LEGACY retirement | 同上（无 final）；每个 target/manifest/rmdir cut 用 fresh inspection 幂等收敛 |
| Process authority | dead、PID reused、alive-owner、unknown、identity drift、PGID drift、tree drift、listener owner/port/identity drift、listener unknown/foreign |
| Provenance 与 replacement | forged stage/signal/retirement/abandoned authority；caller-forged inspection kind；authority 签发后 same-byte/new-inode projection replacement；后续未授权文件保持不变 |
| Lifecycle owner | nullable ordinary stop；非空 upgrade owner binding 的 owner record 与 receipt/owner-stage authority冻结；owner record mutation使 inspection `INVALID` |

## Checkpoint 边界与最终验收关系

- D2 协议本身不调用 `kill`、Job Object、taskkill、CIM 或其它 OS signal；production host 负责以真实 process/listener facts 消费 signal target，并在 OS 终态复核后请求 retirement authority。
- 本 checkpoint 的 focused matrix 不是最终真实环境声明。production wiring、源码树外 tarball、Local panel、B 包读取、独立 B setup/uninstall/purge 与终态边界以 P4 README 为准。
- 按用户授权的“最小真实运行优先”，最终候选没有重跑 switched-WAL、kill-cut、并发或异常恢复矩阵；这些是自动化/历史辅助证据，并延期到 P9/P10 的最终质量评估。
