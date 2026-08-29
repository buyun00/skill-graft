# P3 物化引擎与旧链接迁移真实环境证据

## 结论

P3 于 2026-08-23 完成。无副作用 `planSync`、copy 物化、Git 可见性所有权、attach completion、显式 Junction/HardLink 迁移与回滚，以及 durable-old/durable-new 崩溃恢复，均已通过源码外打包安装和真实 Windows 跨盘验收。

- 基线 SHA：`10b3188be52434c41e3139a95e2158a000461c35`
- 分支：`codex/skill-graft-dual-host`
- 验收实现 / 已核对远端 SHA：`8cbbd9a5717b3e3e573785f5b7d4e633d2ccc05d`
- 最终 run-id：`p3-20260823-7b45dd9ae53f`
- 主验收根：`F:\skill-graft-e2e\p3-20260823-7b45dd9ae53f`
- 跨盘根：`C:\skill-graft-e2e-cross\p3-20260823-7b45dd9ae53f`
- 阶段封口：本记录所在提交
- 原始证据策略：tgz、worker stdout/stderr、trace、WAL 检查数据和运行态只保留在 marker 所有的隔离根；仓内只记录脱敏结论与摘要

## 候选包与验证入口

验收先从当前源码执行 build，再 `npm pack`、安装到 marker-owned `app`，后续只调用安装态绝对 `sg.cmd` 和安装包内 adapter；PATH 中没有宿主 `sg` 或 `dsh` 可供误用。

| 项目 | 结果 |
|---|---|
| 包 | `ozdqp-skill-hub@0.1.0`；229 个安装文件 |
| tgz | 766947 bytes；SHA-1 `01ceb4ffcedbfe935586dd85ac881c3c30f57974`；SHA-256 `1242e05b9f6bef77cbd6b365a9a5ee07e3b7fa729ed43fc6f5e4f1bc12292aac` |
| installed-real | 1/1 pass、0 fail、0 skip；test `631597.505ms`，total `631730.4478ms`；唯一正式运行，无重试 |
| 最终默认回归 | 562 tests、560 pass、0 fail、2 platform skip；`575614.6056ms` |
| focused | legacy 38/38（`416779.2427ms`）；ordinary 62/62（`439805.0305ms`） |
| build / typecheck | `npm run build`、`tsc --noEmit`、相关 `node --check` 与 `git diff --check` 全部通过 |
| 脱敏 summary | 1732 bytes；SHA-256 `4e539d1275377fcfdf91865227f44ed5b37532f5048e3c4893e6a0b7dfd48e8c` |

## Ordinary 物化与 attach completion

- snapshot A `sha256:e040df7f6cae14804251df866009595cdd39acdce611773d2f7000839f9bcefb` 与 B `sha256:347d2b55ae04574721d6f337dbc8c61f4dbf08643dd0b3f2742802acd2c6cd3e` 依次完成 H→S→升级→H 生命周期。
- `planSync` 保持零写；`sync` 在 lease、identity、marker、visibility sidecar、Git index/config/private exclude 与内容摘要复检后，按 visibility-safe 阶段发布，marker 最后落盘。
- 首次 attach 只接受同 target 的 `waiting + exitCode=0` 会话；changed 与 external no-op 都在同一 Hub WAL 内写入 locator-free completion proof。失败、participant rollback 与 session 写失败均不冒充 completed。
- base exclude 漂移稳定拒绝旧计划，手改受管内容返回 `CONFLICT_DIRTY`，unmanaged exact 内容返回 `CONFLICT_CONTENT`；CLI reopen 和 daemon no-op 均不重写物化真相。
- deselect 精确恢复 tracked skip/private exclude 基线；无根环境的真实 hook 仅从 worktree config 找到安装包与 data root，未回退到源码或 packageRoot 数据。

## 显式旧链接迁移与回滚

- 普通 sync 遇到旧链接只冲突，不暗拆；显式 dry-run 后，3 个真实 Junction/HardLink 被替换为独立副本，原对象与 Git/config/base/private 事实进入 content-addressed 永久 backup。
- migrationId 为 `sha256:19207cec7c209c5ffc6dfb670e0b406f755317e8d3f8f8cff7230cf8aa7d97d9`；提交后新进程 dry-run 返回 `already-migrated`，并严格验证 record、marker 与 retained private envelope。
- durable-old worker 在 marker publication checkpoint 后被预期 `SIGKILL`；lease 到期后的 daemon recovery 恢复旧链接，再生成稳定 replan 并正常提交。
- rollback durable-new worker 在 Hub WAL `wal-published` checkpoint 后被预期 `SIGKILL`；transaction hash 为 `sha256:a8a67ec572532f56c1b3193d540270bf626a5dd5fc990927e4d50db7a8fa54b4`。daemon recovery 后同请求返回 replay，最终 record 为 `rolledBack`、marker 为 `null`、3 个原链接恢复。
- common `info/exclude` 只删除/恢复字节级精确 owned 行；迁移和回滚均冻结真实 sibling visibility proof，并在持有 Git locks 后再次复检。unsafe sibling 在计划阶段冲突，计划后漂移稳定 stale 且零越权写入。
- focused 还覆盖 rollback 后同 plan/id remigration、second-crash、finalize tombstone、backup/claim 替换攻击、restore source valid/missing/changed/unsafe 与 missing common exclude 的物理 absence。

## 跨盘、保护面与残留

- marker-owned 不同盘 worktree 的 `claim` preflight 返回 `UNSUPPORTED_LAYOUT` 且零写；worktree、Git admin/common、Hub data、安装包与跨盘根前后字节清单一致，跨盘根最终只剩原 marker。
- `AGENTS.md`、`unity-skills`、项目自有 Skill 和 5 个保护根均保持前置 HEAD/index/status/diff/untracked 或 whole-tree 指纹；每次保护 Git 采集前后 index bytes 也完全一致。
- 最终 owned process、DSH 进程、Hub WAL/lease/staging/retired、daemon pid/heartbeat/stop、ordinary/legacy transaction 和 Git `.lock` 残留均为 0。端口 18765 始终只有前置 PID `91276`，本轮动态端口与 3080 最终无 listener。
- `logs/` 共 73 个文件、70189 bytes；全量扫描不含验收根、盘符/UNC locator、`ownerToken`、`message` 或 `details`。6 个 worker 中 4 个正常 exit 0，2 个正是上述预期 SIGKILL cut。
- 安装树不含 `src/`、`test/`、Hub state、session、WAL 或运行态 residue；包内 10 个 required P3 入口均由 real gate 强制检查。

## 失败轮次与审计透明度

P3 real gate 采用 fresh-root、单次正式运行、失败根永久保留的规则。此前轮次依次暴露并关闭了 fixture recognition、sibling safety、短 lease/timeout、detached daemon XDG identity、committed migration reopen 和 rollback restore sibling proof 等问题；任何失败根都未清理、修补后重跑或复用。

第六轮失败后的手工收口曾误用未禁 optional lock 的只读 `git status`，导致本开发 worktree index stat-cache 原子刷新；HEAD、porcelain、staged/work diff 与 untracked 内容未变，未尝试还原 index。其后全部保护采集固定使用 `GIT_OPTIONAL_LOCKS=0` 与 `git --no-optional-locks`，最终成功轮的 workspace index 前后均为 26140 bytes、SHA-256 `b7bbfcc0bba61b562d1fae8bb1caa796fcc2e4525ecfe86dffd1e34f6809acb2`。

## 阶段边界

P3 只封口物化计划/执行、attach completion、旧链接显式迁移/回滚和相应 Local adapter。P4 才完成自包含 Local 发行与安装/升级/卸载边界；P5 才实现正式 Codex SessionRunner；P6–P8 才进入 DSH bundle、UI 与 SessionRunner。本轮未宣称 P4–P10 能力。
