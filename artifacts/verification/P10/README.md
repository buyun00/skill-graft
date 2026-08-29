# P10 范围受限发布候选验证记录

## 结论

P10 按协调线程固定的“范围受限 RC”口径封口，**不是 GA，也没有通过完整 P10 runtime lifecycle 门禁**。本轮真实完成了 release build、四个 A/B 发布包的源码树外 staging/pack、Local A/B 的源码树外 npm install、license/内容/本地依赖泄漏审计、保护根拒绝与前后指纹。Local `setup` 在进入产品逻辑前被 runner 隔离 PATH 夹具阻断；按收敛指令未重跑，因此 Local status、真实升级/降级拒绝、卸载/purge，以及全部 P10 DSH add/RPC/remove 均明确未验证。

本 RC 只声明两轨代码已合流，并保留 P4–P9 已经分别记录的 shared state、snapshot、pin、request ledger、schema、lock、SessionRunner 和各宿主历史证据。P10 新证据不得替代或抬高 P8/P9 的 DSH RPC/composition 口径，也不得推导同一 probe 跨宿主物化一致、完整双宿主安全共存或 GA ready。

## Git 与范围基线

- 专属分支：`codex/skill-graft-p10-release-candidate`
- P9 封口基线：`c539aca29d5a32fea5898be5fc6a292165248e54`
- P9 no-ff 合流：`e9d044a4d5298fc35b1594d9ea1d5b9f67233e93`
- 已只读确认 P8 `604da2ffde1ea40b2798d32310710ab6183b7d80`、P5 `14f9481bd007589b5c83cd01a73fae9a0f6256b8`、P4 `43ac1875ab6a08892f6ce222f95c90011affb619` 均为祖先。
- P10 阶段封口 SHA 为**本记录所在提交**；包通过本提交中的 runner、版本元数据、`.npmignore` 和源代码范围与下表 SHA-256 关联。
- 只读 `git ls-remote --symref origin HEAD` 显示远端 default branch 为 `master`，当时 SHA 为 `cfe617738ada757e042526d127df546092bce6c2`。本任务不切换、修改或推送 `master`，也不改变 default-branch 设置。
- 用户已经授权候选分支封口后，由协调线程创建独立干净交付任务，将本 RC（含 P4–P9 祖先）no-ff 合入并推送 `origin/master`；该 Git 交付不等于 GA。

执行工具：Node `v24.15.0`、npm `11.12.1`、pnpm `11.19.0`、Git `2.49.0.windows.1`。

## 最小实现差异

- Local lifecycle 在读取并核对已安装 package/manifest 权威后、建立本次 snapshot/lock/WAL 或停止 daemon 前，按 SemVer precedence 拒绝低版本候选；同 precedence 的不同发布字节继续 fail closed。
- focused 合同补充非 dry-run `2.0.0 -> 1.0.0`，验证 install tree、data tree、root receipt、lock/WAL 字节不变。
- Local 与 DSH runtime 版本统一为 `0.1.1-rc.1`，两包声明 Apache-2.0；DSH stage 复制根 LICENSE。
- Local `.npmignore` 排除独立 DSH 源包目录 `packages/`，修复真实 pack audit 发现的发行串包。
- P10 runner 只消费已经构建的 release 输出，在 UUID 根生成 A/B 包并隔离 HOME/DSH_HOME。最后一次 PATH 失败后增加 run-root `node.cmd` 绝对 wrapper；该夹具修正只通过 `node --check`，依收敛指令**未重跑**。
- 没有修改冻结的 `src/contracts`、`src/core`、`src/application` 或 SessionRunner。

## 构建与 focused 证据

| 类别 | 结果 | 准确口径 |
|---|---|---|
| `npm run build` | 通过 | 干净工作树首次因无 `node_modules`/`tsc` 失败；`npm ci --ignore-scripts --no-audit --no-fund` 后只重试一次并通过 |
| focused downgrade 合同 | 1/1 通过 | 只运行 `path-enabled upgrade binds full dist/web identity and remains idempotent`；没有运行 P4 默认/完整矩阵 |
| Local release build | 通过且有限制 | 首次 Next export 在 optimized build 阶段无诊断 exit 1；只重试失败组件 `npm run export:web` 后通过，随后 `npm run verify:release` 确认 8 HTML、38 canonical files |
| DSH release build | 通过 | `npm run build:dsh` 生成源码树内忽略的临时 stage；tgz 在 run-id 根生成 |
| P10 runner 静态检查 | 通过 | 最终 Node wrapper 修正后 `node --check test/real/release/p10-release-candidate.mjs` exit 0；未再次真实运行 |

没有运行默认完整套件、协议/故障注入、性能、长期、排列组合或重复 safety。

## 真实包证据

最终 fresh run：`p10-00f0d4ce-548c-4e7e-80b1-55b326355971`，根为 `E:\skill-graft-e2e\p10-00f0d4ce-548c-4e7e-80b1-55b326355971`。运行根、tgz、npm cache、安装目录和原始日志均保留在源码树外，不纳入 Git。

| 包 | 版本 | 文件数 | 字节 | SHA-256 |
|---|---:|---:|---:|---|
| `ozdqp-skill-hub-0.1.0.tgz` | `0.1.0` | 266 | 1,027,697 | `ac5afd0ed323ad3480e72a670da0530940b1008b01f1dcebf636f7fc7aa3c162` |
| `ozdqp-skill-hub-0.1.1-rc.1.tgz` | `0.1.1-rc.1` | 266 | 1,027,700 | `69a7056045958886e1d1dfe4e3dd6449ba674ca555f3056e63e55018fd0a28a3` |
| `ozdqp-skill-graft-dsh-0.1.0.tgz` | `0.1.0` | 8 | 204,028 | `932370a67729e3a9c3afefbc7dd929907f6017dda1921356a257337cb777ec5b` |
| `ozdqp-skill-graft-dsh-0.1.1-rc.1.tgz` | `0.1.1-rc.1` | 8 | 204,033 | `0adfceba75f5fd44db93ca2d1aef0b4d16bd16eaad28f9aeb50e092d8117891d` |

四包均声明 Apache-2.0 并包含 LICENSE；stage audit 未发现 `src/test/docs/artifacts/node_modules/.agents/.codex`、私有 Skill、tgz、`.env`、key/certificate 或 Local `packages/` 串包。Local runtime dependencies 为空。DSH 仅声明 registry 形式的 `@deepseek-ai/schemastery`、React 和五项 DSH peer dependency，没有 `file:`、`link:`、`workspace:`、绝对路径或 source/Harness 路径；clean registry-only peer closure **没有在 P10 重新验证**。

A/B Local stage 除 `package.json` 版本元数据外代码和资产逐字节相同；A/B DSH stage 除 `package.json` 与 `build-manifest.json` 版本元数据外代码和资产逐字节相同。

## 真实、fallback 与未验证

### 本轮真实

- 18 个保护根（含 aa1d、P4/P5/P6-P8/P9/P10 Skill Hub 工作树、中心树、Harness 和已发现的 OZDQP 根）先记录指纹；runner-side 越界目标 `f550` 被拒绝。最终 fresh run 的 18 个前后指纹一致。
- Local/DSH A/B 四包完成源码树外 staging、内容/license/runtime dependency spec 审计和真实 `npm pack`。
- Local A 与 B 均以 `npm install --prefix ... --ignore-scripts` 安装到 fresh run 根；两者外部 `.bin\sg.cmd` 均存在、package version 分别为 `0.1.0`/`0.1.1-rc.1`，且安装包不含 `src/`，不位于开发树。
- 前两次收敛运行没有进入产品逻辑；最终 fresh run 也没有成功进入 Local setup 或启动 DSH profile。三次 run-id 均无自有残留进程；精确 Local/DSH lease、shared transaction、lifecycle lock/WAL/purge-WAL 和 lifecycle installDir 路径均不存在。

### Fallback

- P10 没有执行 composition fallback，也没有用 focused/mock 冒充 installed happy path。
- P8 的真实 DSH RPC 与 P9 的源码树外 composition fallback 仅作为历史证据引用，不计入 P10 新门禁。

### 未验证

- **Local installed happy path 未验证。** 最终 fresh run 的 `local-a-setup` 在进入产品逻辑前因 runner PATH 找不到 `node` 而 exit 1；不得称为 Local happy path、setup、doctor 或 status 通过。
- Local A→B 真实 lifecycle upgrade、B→A SemVer downgrade 拒绝及外装权威字节保留未执行；只有 focused 合同通过。
- Local uninstall、Hub 保留和唯一 purge 未执行；由于 setup 未进入，未产生 lifecycle install/data authority 可供卸载或 purge。
- **P10 DSH tgz add/dump/profile/live RPC/B upgrade/remove 全部未执行。** 因而 P10 DSH installed happy path 和 live RPC 均未验证；P9 的 RPC 空响应边界保持不变。
- 没有真实 Codex/DSH provider session、浏览器逐项点击、失败升级回滚、clean registry-only DSH peer install、故障注入、性能或长期运行证据。
- 最终 Node wrapper 是夹具静态修正，只通过语法检查，没有真实复验。

## 收敛运行记录

1. `p10-2ab1536f-9872-4008-b979-d47b6abc2076`：runner 对 run 根自身父目录校验过严，并把一个无有效 HEAD 的 partial 目录误作 Git root；在 pack/install 前退出。修正仅涉及 runner preflight。
2. `p10-65620e95-76fa-431d-b347-637d4f3b5deb`：pack inventory 后，真实 scope audit 发现 Local 包包含四个 `packages/host-dsh/**` 文件；没有生成 tgz/安装/进程。`.npmignore` 增加 `packages/` 后获协调线程授权做一次 fresh package preflight + 最小外部 smoke。
3. `p10-00f0d4ce-548c-4e7e-80b1-55b326355971`：四包 pack 和 Local A/B 外部 npm install 真实通过；首次 Local setup 因 runner PATH 缺少 `node` 退出。协调线程将其分类为 fixture 缺陷并要求不再运行；随后只提交静态 Node wrapper 修正。

## RC/GA 已知限制与发布判断

- **#3 GA 阻断：** Local 17 项与 DSH 2 项 runtime asset closure 仍映射到同一 `localOverlay` 合同；同一 probe 的跨宿主 planHash、bytes、marker、materialization 一致性未建立。正确修复需要 Contracts/Core/marker 版本迁移，本 P10 不展开。
- **#1 RC 限制：** 所有写仍先取得 `hub-global`，不同 probe 也安全串行；真并行需要分片 transaction/ledger/WAL 迁移。
- **#2 RC 限制：** Local/DSH UI 没有跨宿主 lock owner 的安全只读投影。
- **#4 RC 限制：** P10 DSH live RPC 未执行；P9 Web readiness 后空响应时序边界仍在。
- **#5 RC 限制：** P9 busy 是 operator-observed `LOCK_BUSY` 加 exit-0 suffix 副作用证明，不是绿色整链。
- **P10 runtime gate 限制：** 本轮只有 pack 与 Local npm install 的新真实证据，installed Local/DSH public happy path 和 lifecycle cleanup 门禁未验证。

因此发布判断是：允许作为**范围受限、runtime gate 未闭合的 RC 分支封口**，不得声明 GA、完整 P10 E2E、Local/DSH installed happy path 或“两发行安全共存已完整验证”。
