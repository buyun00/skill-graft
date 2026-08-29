# P6 DSH bundle 与进程内装配真实环境证据

## 结论

P6 于 2026-08-25 按“最小真实运行优先”完成：独立 DSH tgz 可由指定的 DeepSeek Harness 源码安装到隔离 profile，Host/Client RPC 在 DSH 进程内调用共享 `HubApplication.execute`，配置、pin 写入、plan、profile 重启与 dispose 均取得本轮真实结果。发行包不包含 Local CLI/server/session runner，也不要求外置 Local 安装。

- 基线 SHA：`43ac1875ab6a08892f6ce222f95c90011affb619`
- 分支：`codex/skill-graft-dsh-p6-p8`
- 阶段封口：本记录所在提交
- real run-id：`P6-real/20260825T110830`
- 隔离根：工作树忽略目录 `.artifacts-local/P6-real/20260825T110830`
- DSH_HOME：上述隔离根的 `dsh-home`
- DSH 源码：`E:\deepseek-harness-master`，`@deepseek-ai/dsh-root 0.1.0-rc.5`
- P8 待消费共享基线：`29ea16e32f95a6cd9e1f31b90d223d6c332cf509` → `d2a96110512114c430f370ae4c21616bb83c1b13`

## 验收环境

| 组件 | 版本 / 边界 |
|---|---|
| Windows | `win32 x64` |
| Node.js | `v24.15.0` |
| pnpm | `11.19.0` |
| DSH | 源码包 `0.1.0-rc.5`；真实 production build |
| Skill Graft DSH | `@ozdqp/skill-graft-dsh@0.1.0` |

## 自动化最小门禁

| 验证 | 结果 |
|---|---|
| `npm run build:dsh` | exit 0；root TypeScript compile + 独立 Host/Client esbuild |
| `npm run test:real:dsh:p6` | 2/2 pass；bundle closure/package contents + composition/pin/plan/dispose/reopen |
| shared/package focused 回归 | 43/43 pass；contracts-application、shared-boundary、package-contract |
| `npm pack --dry-run --json --ignore-scripts` | 7 个发行文件；无 `dist/local`、`dist/control`、server 或 Local session runner |
| shared source diff | P6 未修改 `src/contracts/**`、`src/core/**` 或 `src/application/**` |

范围化测试只覆盖 P6 公开接口的一次 happy path/必要边界；未运行 P4 耗时约 6647 秒的默认全量套件，也未扩张故障排列组合。

## 真实 DSH build、安装与配置

1. 在 `E:\deepseek-harness-master` 执行 `pnpm run build`：host/client libraries 与 Web frontend production build exit 0；Web build 413 modules。
2. 独立 tgz：`ozdqp-skill-graft-dsh-0.1.0.tgz`，171804 bytes，unpacked 961666 bytes，SHA-1 `6d1198fbeb3195d5ab908ae4c93949b40085e2a7`，integrity `sha512-gRbBHuZDAGGj1Jlt5lGZTOudSrxFX2cqTebAKrYeVjx8pOQUYr+A8IlfXoB5xX+GI29v0cblEnyhwRVTM4SOaw==`。
3. `pnpm dsh plugin --profile web add <tgz>` exit 0；profile bundles 为 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@ozdqp/skill-graft-dsh`。
4. `pnpm dsh --profile web --dump-config` 显示 `skill-graft-dsh` Host 行、`inject: [connection]`，以及 `dataRoot/workspace/autoSync/lockTimeoutMs/logLevel` 的安全默认值。
5. 本轮执行一次 remove/add 与两次 profile 启停；第二次安装无 peer warning，证明 tgz/profile lifecycle 可重放。

真实安装首先暴露 pnpm 内容寻址 hardlink：旧 reader 将合法已安装文件误判为不安全，`planSync` 返回 `RUNTIME_ASSET_INVALID`。最终候选只放宽稳定 hardlink 的 link-count 限制，仍复核 plain-file、realpath、opened inode/size 和 SHA-256；重装后同一 real gate 成功。

## 真实 RPC 与写入边界

所有以下结果均由 `POST /skill-graft/execute` 的 DSH Connection RPC 返回，内部 envelope 的 `meta.handler` 均为 `application.commandBus`：

| 路径 | 真实结果 |
|---|---|
| `status` | `ok=true`；hubRoot 指向独立 DSH_HOME 下 `skill-graft` |
| `listSkills` | `ok=true`；初始安全空态，加入 fixture 后 resident `ozdqp-development.hasSkillMd=true` |
| `listWorktrees` | `ok=true`；初始空列表 |
| `inspectSchema` | `ok=true`；初始 `status=empty`、`migrationRequired=true`、runtime `0.1.0` |
| `createSnapshot` | `ok=true`；snapshot `sha256:3d9cc0ee0f1f6b1f8d1da1059860aa165249fbc9f772ebb7b32c0f7b3f6d2608` |
| `migrateState` | dry-run 后同一 plan commit；`ok=true/status=committed` |
| `getPin` | `ok=true/claimState=claimed` |
| `setPin` | `ok=true/changed=true`，selected Skill 仅 fixture skill |
| `planSync` | 修复/重装后 `ok=true/status=conflict/executable=false`；planHash `sha256:0660789778b9b89eb3fea2a73aecdb16678734c756f45fb641d93383c70159b1` |

P6 fixture 通过显式旧 claim 迁移取得 pin；因为没有 P8 attach 会话授权和已提交 marker，plan 的业务 conflict 是正确的必要边界。P6 没有伪造 session、绕过 first-attach policy 或执行不可执行 plan。

## 外部 Local 零依赖与 dispose

- 本机外部 18765 listener 在验证前已存在，属于本任务范围外；没有停止或修改。
- 用绝对 pnpm 路径启动第三次 DSH profile，并从该子进程 PATH 精确移除全局 `sg.cmd` 所在目录；启动日志记录 `SG_AFTER_SANITIZE=`。
- DSH Web 监听 `127.0.0.1:61453`，owner 为 node PID 82820；该进程对 remote port 18765 的连接数为 0。
- 同一隔离进程内 status RPC 仍 `ok=true` 且 handler 为共享 Application。
- 正常停止后 PID 82820 不存在、61453 listener 不存在。前一轮随机端口 64948 同样关闭。
- bundle 的 Host/Client JS 不含 `127.0.0.1:18765`、Local Codex session runner 或 Local launcher；发行清单只有独立 Host/Client、patch、metadata 与两个 DSH runtime 文件。

## 已知限制 / backlog

- P6 不含产品 UI、DSH settings 持久化表单、workspace 选择器、Skill 注册或 inbox 交互；这些是 P7。
- P6 不实现 SessionRunner；临时 session port 对会话写请求 fail-closed。P8 必须先按顺序纳入 P5 两提交，再实现 start/resume/cancel/status/events。
- 未验证首次 attach、可执行 sync、无父会话入口、真实 DSH 对话、resume/cancel；这些是 P8，不以 P6 的旧 claim fixture代替。
- 未运行 HMR、长期运行、并发锁、schema mismatch、崩溃恢复或网络/权限故障矩阵；分别进入 P9/P10 或后续质量阶段。
- P6 composition 复用已经审计的 Node/P2/P3 adapters，其中部分文件名仍带 `local-*`；共享业务只经 Application，机械重命名作为非门禁技术债，不在 P6 扩张。
