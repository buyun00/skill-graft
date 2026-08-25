# P2 snapshot、pin、迁移与跨进程锁真实环境证据

## 结论

P2 于 2026-08-22 完成。内容寻址 snapshot、`HubStateV2`、`WorktreePinV1`、V1→V2 显式迁移、事务 WAL 和 lease lock 已通过源码外打包安装及真实 Windows 多进程验收。P2 只证明版本库、pin、迁移与锁；copy 物化和旧链接拆迁属于 P3，尚未开始。

- 基线 SHA：`8b478c74255f7789249fdab91ca53528493780c5`
- 分支：`codex/skill-graft-dual-host`
- 最终 run-id：`p2r2-20260822-154850-bd34712`
- 验收实现 / 已核对远端 SHA：`ae3af36733305c80283848dd5a17b3df172c1b8e`
- 阶段封口：本记录所在提交
- 原始证据策略：原始命令、worker stdout/stderr、metadata、tgz 和运行态数据只保留在 marker 所有的隔离根；绝对隔离路径、owner token 和运行态数据不入库

## 候选包与安装态入口

候选执行 `npm pack` 后安装到本轮独立 `app`，验收只调用安装态绝对 `sg` 和安装包内适配器，不从源码目录运行产品入口。

| 项目 | 结果 |
|---|---|
| 包 | `ozdqp-skill-hub@0.1.0` |
| npm pack SHA-1 | `b8fd4ccd3dd791ec55e04709675bb457dd346fdd` |
| installed-real | 1/1 pass；`32.76s` |
| 最终默认回归 | 两轮均为 403 tests、401 pass、0 fail、2 platform skip；`477.38s` / `483.30s` |
| clean build / dry-run pack | build exit 0；217 项、653591 bytes、unpacked 1958388 bytes；SHA-1 与 installed-real 相同，未生成 tgz |
| data-root aliases | `SKILL_GRAFT_HOME` only、`HUB_ROOT` only、等价双变量均通过；冲突在写入前失败 |
| 外部宿主 | 未启动 Codex 或 DSH；隔离 `DSH_HOME` 最终为 0 项 |

## Snapshot 合同

- snapshot A 创建后，mtime 和排除域变化再次捕获仍去重到 A；受控内容变化生成不同的 snapshot B。
- 物理仓共 2 个 immutable manifest、6 个 CAS blob；每份最终 manifest 捕获 5 个文件。
- 捕获域只有 `AGENTS.override.md`、3 个 resident Skill 和 `skills/adopted/**`；`skills/inbox`、`skills/README.md` 及全部 overlay 明确排除。
- list/show、blob 长度与 SHA-256 closure 均由安装态 CLI 回读验证。

## 迁移与 Pin 合同

- dry-run 与 commit 均识别 `claimed`、`linked`、`unmanaged` 三类；dry-run 不修改 V1/V2、probe 或 snapshot 业务域，但保留事务 ledger/audit。
- commit 原子生成 `HubStateV2`；重复 commit 返回 `already-current`，安装态 `status` 成功读取 V2，存储用 `gameRepoId` 不泄漏到读模型。
- 两棵受管 probe 分别请求 A/B；新进程回读后 `materializedSnapshot` 仍为 `null`，证明 P2 没有冒充 P3 物化。
- pin set envelope 和 completed ledger/result 只保存 `pathKey`、`worktreeId` 与 pin，不保存 raw worktree locator；probe 字节、Git index、HEAD 与 porcelain 保持不变。

## Lease、WAL 与进程证据

- 两个真实 Node contender 的结果精确为一方 `acquired`、一方 `busy`。
- WAL owner 被一次预期 `SIGKILL` 终止；owner dead 但 lease 未到期时 recovery 返回 `LOCK_BUSY` 且零写，dead + expired 后恢复 1 个事务并得到完整新状态。
- 共保存 29 条命令证据：27 条 exit 0；2 条预期非零分别为 data-root conflict exit 1、lease 到期前 recovery exit 2。
- 共 6 个 worker、18 个证据文件：12 个 64 KiB 有界原始 stdout/stderr 文件和 6 个脱敏 metadata；metadata 与 summary 不含 raw path、owner token、message 或 details。
- 最终 marker-owned 进程、WAL/lock/tmp 残留和 `DSH_HOME` 项均为 0；端口 18765 listener 前后均为既有 PID `91276`，本轮没有启动或替换它。

## 首轮失败与锁修复封口

首轮 run-id `p2-20260822-113300-8b478c7` 在真实 contender 阶段暴露 fresh staging publication 与 `ensureDirectory` 的 Windows 并发消失窗口；该失败根永久保留，未清理、未复用。修复保持 fail-closed 身份校验，只把精确观察对象已经消失的竞态窄化为幂等或重试。

修复后的封口验证包括实现侧 200/200 contender、独立 seal 2×100 contender、dual stale-sweeper 50/50，以及 storage + lease focused 51/51，随后才执行最终 installed-real run。

最终默认回归还发现测试包装器的递归环境隔离探针会并发重写共享 `dist`。该探针已改为真实执行 `tsc --noEmit`，并以 emitted CLI/install 的 bytes、size、`mtimeNs`、`ctimeNs` 全不变为回归门禁；修复后连续两轮完整 403 项回归均零失败。

## 安全边界与远端封口

路径 containment、`lstat`/`realpath`、plain-file/plain-directory 和 `wx` 门禁防止验收自身越界，但不能单独防住同一权限主体在检查后进行 path swap。Windows 生产数据根、安装根和受控父目录仍必须用 ACL 限制同权限非受信进程的写权限；这是一项部署前提，不得把路径检查描述成权限隔离。

独立 post-run 对照已 GO：固定 probe 仍为 detached `c992cc988614aaa5f2811c28aa090496cb936d68`，tracked/staged 状态为 0，预存 `origin`、index 摘要及既有链接形态均命中基线；活 Hub 仍为 `master@cfe617738ada757e042526d127df546092bce6c2`，恰保留基线的 2 个 tracked 修改和 2 个 untracked 文件，state/session 摘要、大小与 mtime 均一致，未新增 P2 runtime root 或 tgz。端口 18765 的唯一既有 PID、进程身份与 health 响应也精确命中前置基线。验收实现 `ae3af36733305c80283848dd5a17b3df172c1b8e` 已推送至 `origin/codex/skill-graft-dual-host`，并用 `git ls-remote` 核对；阶段封口为本记录所在提交。

## 阶段边界

P2 已完成，实施指针移到 P3，但 P3 尚未开始。P3 才实现 copy 物化、冲突处理和旧链接迁移；P4–P5 才完成完整 Local 发行与 Codex SessionRunner；P6–P8 才进入 DSH bundle/UI/SessionRunner。本轮没有验收或宣称任何 P3、Codex Runner 或 DSH 宿主能力。
