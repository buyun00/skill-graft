# P7 DSH 设置、工作区、Skills 与 UI 真实环境证据

## 结论

P7 于 2026-08-25 按“最小真实运行优先”完成：独立 DSH package 在指定 DeepSeek Harness 的隔离 profile 中提供 settings、workspace、pin/plan/sync、Skills、inbox 与 history 页面；Client 只经 Connection RPC 调 Host，业务命令仍由共享 `HubApplication` 执行。workspace 选择、DSH settings 持久化、Skill/override 注册生命周期和 inbox 必要写入边界均取得本轮证据。

- P4 基线：`43ac1875ab6a08892f6ce222f95c90011affb619`
- P6 封口：`51c0743ee6ba61488e3ae8893d1a8ce857856763`
- 分支：`codex/skill-graft-dsh-p6-p8`
- 阶段封口：本记录所在提交
- real run-id：`P6-real/20260825T110830`（在同一隔离 P6 profile 上升级安装 P7 candidate）
- DSH_HOME：工作树忽略目录 `.artifacts-local/P6-real/20260825T110830/dsh-home`
- DSH 源码：`E:\deepseek-harness-master`，`@deepseek-ai/dsh-root 0.1.0-rc.5`
- P8 唯一共享基线：`29ea16e32f95a6cd9e1f31b90d223d6c332cf509` → `d2a96110512114c430f370ae4c21616bb83c1b13`

## 产品边界

- Host 注入 DSH `connection/settings/workspaceRegistry/skills/systemPrompt` 服务，维护显式 workspace 选择和 effects 生命周期。
- Client 注册一个 DSH-native `settings.section`，通过 `/skill-graft/*` RPC 读取状态和提交命令；浏览器不判断 claim、pin、冲突或 sync 可执行性。
- workspace lifecycle 只把已提交 `materializedSnapshot` 的 manifest 内容注册到 `ctx.skills` 和 system prompt；`requestedSnapshot`、pin 输入和任意工作树文件均不能成为提示词来源。
- 切换 workspace、pin 或 materialized marker 时先注销旧 Skill/prompt，再注册新集合；未领取 workspace 只显示 doctor 提示并禁用 pin/plan/sync 写入口。
- 多 workspace 不猜测当前树；DSH settings 保存稳定 workspace id 和 `off/plan/sync` 自动策略。

## 自动化最小门禁

| 验证 | 结果 |
|---|---|
| `npm run build:dsh` | exit 0；root TypeScript compile + production Host/Client bundle |
| `npm run test:real:dsh:p7` | 2/2 pass；production bundle/package closure + workspace A/B lifecycle + pre-accept cancellation |
| `npm run test:real:dsh:p6` | 2/2 pass；P6 bundle/RPC/composition/dispose 回归 |
| shared/package focused 回归 | 43/43 pass；contracts-application、shared-boundary、package-contract |
| `npm pack --dry-run --json --ignore-scripts` | 7 个发行文件；package 181.2 kB、unpacked 1,001,965 bytes |
| candidate digest | SHA-1 `6b23129b2ad25525c18991ae1eaae013a5097c5f`；integrity `sha512-fj7i8aXhURu1+LAAW2fzrSi1N95hVtkfDWheSOCkKiBhw7f1BOB2B3ncw9xcXup2NA4t3L6L+7ENgCB6LOmv7w==` |
| shared source diff | P7 未修改 `src/contracts/**`、`src/core/**` 或 `src/application/**` |

生命周期测试使用真实 snapshot repository、受哈希约束的 manifest/content、真实 DSH Host composition，并以最小 Application materialized-fact shim 与 fake DSH services 观察 `ctx.skills`/system prompt effects：从 workspace A 切到 B 时 A 的注册全部 dispose，B 只读取其 materialized snapshot。没有把 shim/service 结果冒充真实 DSH Web 证据。

## 真实 DSH 安装、设置与 workspace

1. 最终 P7 candidate 经 `pnpm dsh plugin --profile web remove/add` 重新安装到独立 `DSH_HOME`；profile bundle 仍只有 DSH base、DSH Web 和 `@ozdqp/skill-graft-dsh`。
2. 真实 DSH workspace registry 注册两棵隔离 probe：`P7 Claimed Probe` 与 `P7 Unclaimed Probe`，页面下拉框同时显示两者。
3. 选择持久化为 workspace id `0918e6e7-f602-4d65-be7f-0987202ad252`；`autoSync: plan` 写入 DSH `settings.yaml`，刷新页面和 profile 重启后仍保持。
4. Claimed probe 的真实 Application facts 为：requested snapshot `sha256:3d9cc0ee0f1f6b1f8d1da1059860aa165249fbc9f772ebb7b32c0f7b3f6d2608`、materialized `null`、plan `conflict`、executable `false`。UI 因而禁止 Sync，未绕过 P8 attach 授权。
5. Unclaimed probe 显示 claim/materialized 空态和显式 attach 提示，Save pin、Preview plan、Sync 均禁用；打开页面没有改写或移除其 Skill。
6. 最终 cancellation candidate 在 `61455` 启动后，真实 `describe` 返回两棵 workspace、selected claimed probe、`autoSync=plan`；真实 `execute/status` 返回 `application.commandBus` 和同一隔离 data root。

## 真实浏览器与 RPC

真实 Web 监听 `127.0.0.1:61454`，由 Codex 内置浏览器打开 DSH 设置对话框并进入 `Skill Graft`。DOM 与交互确认以下产品面均来自已安装 candidate：

- Settings & doctor：独立 data root、schema current、runtime `0.1.0`、writable true、workspace 与 auto-sync。
- Workspace registration：路径、标题、注册、注销、显式选择。
- Pin/plan/sync：claim、requested/materialized、plan status、executable、conflicts、snapshot、selected Skills。
- Skills：resident/adopted/inbox、`ctx.skills` 当前注册集合和受控 `Read` 详情。
- Inbox/updates：ingest dry-run/commit、adopt/merge/reject。
- History：Application command/state 结果。

在 claimed probe 点击 `Preview plan` 后无 UI error，页面显示真实 `conflict/executable=false`；点击 resident Skill 的 `Read` 返回安装在 DSH data root 内的受控 fixture 内容。Host RPC 返回的 Application envelope 保持 `meta.handler=application.commandBus`。

## inbox 必要写入边界

隔离 `P7 Unclaimed Probe` 仓用两个本地提交构造单个新增 Skill：

- old：`0cb60d2dd1513ed8e5a1328aab082284dffaff9a`
- new：`ae4bc2065bc25c0af187fe938f2c399404261cda`
- ref：`refs/remotes/origin/main`

页面先执行 `Ingest dry-run`，history 增加 `command.succeeded` 且 inbox 保持空；再执行 `Ingest`，页面出现 `p7-inbox-probe / queued`，Skills 的 inbox files 变为 1；最后点击 `Reject`，页面与真实 `skill-review/state.json` 均记录 `status: rejected`，history 出现 `ingest` 与 `decide`。这些写入仅发生在忽略的隔离 DSH_HOME 和 probe。

## lifecycle 与退出

- Host dispose 会停止 settings watcher、注销 workspace Skill/system prompt effects、等待 in-flight RPC drain，再释放 Application composition。
- RPC/Client 的 AbortSignal 贯穿 Host tracking 与 workspace lifecycle：排队或尚未被共享 Application 接受的操作可取消；已经进入 Application 的原子写继续完成并由 dispose drain，避免半写。focused gate 验证预取消不会调用 Application 或写 DSH settings。
- 本轮一次 profile 重启在 Windows CIM creation identity 读取时返回 malformed；按门禁只做一次最小重试，重试立即成功，未修改产品绕过检查。
- 浏览器验收使用 `61454`；最终 candidate 的重装/RPC 复核使用 `61455`。两次均正常停止且 listener 已消失。

## 已知限制 / backlog

- 真实 claimed fixture 只有 requested snapshot，没有 P8 attach 提交的 materialized marker；因此真实 DSH 中 `ctx.skills` 正确为空。真实 materialized 注册、首次 attach 和可执行 sync 归 P8，不以伪造 marker代替。
- P7 没有实现 SessionRunner、对话入口、resume/cancel/events；P8 必须先 fetch 并纳入两段共享基线，核对两者均为 ancestors 后开始 adapter。
- 未运行 UI 故障排列组合、HMR、长期运行、多进程并发或宿主离线矩阵；只完成公开路径的一次 happy path 和必要 fail-closed/write boundary。
- P7 UI 将 Local/P4 已有 Application command 暴露为 DSH 宿主适配；未新增第二套业务规则，也未修改 Local 发行专属代码。
