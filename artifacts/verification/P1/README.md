# P1 共享 Contracts/Core/Application 真实环境证据

## 结论

P1 于 2026-08-22 11:21 +08:00 完成。共享 Contracts/Core/Application 已成为 Local 发行的唯一业务契约；CLI、HTTP、daemon、网页、hook 和兼容 PowerShell façade 不再各自持有业务策略。候选通过源码外 npm 安装、真实 daemon/API、真实浏览器写路径和进程级签名 trace 验收。

- 基线 SHA：`783f4a3c66a65b25557dd98f4bec0124d839987b`
- 验收实现 SHA：`a003614f1b496a81d33ca02876e69f538854428d`
- 分支：`codex/skill-graft-dual-host`
- 最终 run-id：`p1-final-20260821-191126161-248aa1f6`
- 隔离根：`F:\skill-graft-e2e\p1-final-20260821-191126161-248aa1f6`
- 原始证据策略：JSON、签名 trace、trace key、截图、tgz 和运行态数据只留在 marker 所有的隔离根；本文件仅保留脱敏断言、大小与摘要。

## 候选包与运行环境

候选从验收实现执行 `npm pack`，随后安装到本轮独立 `app` 目录。CLI、daemon、API 和网页均从安装包运行，不从源码树运行。

| 项目 | 结果 |
|---|---|
| 包 | `ozdqp-skill-hub@0.1.0` |
| tarball | `ozdqp-skill-hub-0.1.0.tgz`；`577518` bytes |
| npm shasum | `80e9b19fdb6b38207224789f6879cb6e3820889f` |
| package exports | 3 个 private deep import 均被拒绝 |
| Node / npm | `v24.15.0` / `11.12.1` |
| Git | `2.49.0.windows.1` |
| pnpm / DSH | P1 不调用；DSH 源码基线为 `0.1.0-rc.5`，PATH 已移除外置 `sg`/DSH provider，隔离 `DSH_HOME` 未使用，DSH descendant 为 0 |
| 数据隔离 | HOME、APPDATA、LOCALAPPDATA、TEMP、npm cache/prefix、Git 配置、安装根与 Hub 数据根相互隔离 |

## 自动化与合同验证

| 命令或套件 | 结果 | 关键合同 |
|---|---|---|
| `npm run build:shared` | exit 0 | shared Contracts/Core/Application 可独立编译 |
| `npm run build` | exit 0 | Local 发行 TypeScript 构建通过 |
| `npm test` | 293 total / 292 pass / 0 fail / 1 intentional skip | Contracts/Core/Application、CLI、HTTP、panel、安装、legacy façade |
| `test/e2e-safety.test.mjs` | 28/28 | run-id、canonical/reparse/Git 边界、Job Object、Windows shim 与活树保护 |
| daemon lifecycle/local-session fixture | 2/2 | daemon 真实 `reapSessions` 与进程 trace |
| `npm run test:real:local:p1` | 1/1 | npm pack、隔离安装、setup/doctor、daemon/API/web、CLI↔HTTP、trace 与 browser seed |

共享合同覆盖 7 个查询命令和 12 个写命令。每个写命令验证第一次执行、同 payload replay、不同 payload `REQUEST_ID_CONFLICT`，且 replay/conflict 不产生第二次业务副作用或审计。依赖门禁确认 shared 层不引入 Node 宿主 API、HTTP、React、PowerShell、Codex、DSH 或 Cordis。

## 真实 Local 安装、daemon、API 与网页

| 项目 | 结果 |
|---|---|
| 安装生命周期 | `sg setup`、`sg doctor`、`sg status`、`sg list-worktrees` 均由安装包 shim 成功执行 |
| 随机端口 | `52779`；未使用 `18765` 或 `3080` |
| HTTP / 静态网页 | `/api/health`、首页、深链和静态 asset 均 HTTP 200；asset `23701` bytes |
| 根一致性 | health 返回的 package root 与 data root 均匹配本轮安装；运行态只在隔离 data root |
| daemon | 真进程启动、停止均成功；自动化停止时端口释放、run-id 进程为 0 |
| 进程边界 | API 是 daemon 的直接子进程；CLI intermediary descendant 为 0；DSH descendant 为 0 |

## 同一 Application 与进程级 trace

- 验证了 7 个非空签名 trace 文件、28 条记录、14 个 entry/result 对。
- handler identity：`application.commandBus`。
- handler build identity：`sha256:2395c464f5805e0de510a4a9c115dcc019db173685a129f665f7cd84d053836d`。
- CLI 执行 1 次；HTTP 使用同 `requestId` replay 1 次；不同 payload 返回 `REQUEST_ID_CONFLICT`。
- 业务副作用、ledger 与 audit 各 1 次；replay 未重复写入。
- daemon、API 的 environment identity 与验收环境一致，PID 角色匹配；trace 中没有出现未脱敏 requestId 原值。
- CLI/HTTP 结构化状态相等，seeded inbox 的 CLI/HTTP/legacy 投影相等；HTTP 不 spawn CLI 获取业务结果。

## 真实浏览器写路径

浏览器在真实安装态 daemon 上打开 `/updates/p1-inbox-p1-final-20260821-191126161-248aa1f6`。queued 页面真实 DOM 显示“更新中心”、目标 id/name、`queued` 和小写 `reject`；随后只点击一次 `reject`。

| 断言 | 结果 |
|---|---|
| acceptedAt | `2026-08-22T03:21:29.353Z`（2026-08-22 11:21:29 +08:00） |
| 写请求 | `POST /api/decide`，HTTP 200 |
| 兼容元数据 | `Deprecation: true`；`Link: </api/command>; rel="successor-version"` |
| Application trace | API PID `70608` 恰有一对 `decide` entry/result；`ok=true`、`replayed=false` |
| 刷新后 DOM/API | item 为 `rejected`；queued 为 0；由实际 items 推导 rejected 为 1 |
| queued 截图 | `20976` bytes；SHA-256 `d5a0b348db2f72b6cbc5d482876492700190af63edc6d3274b4cd984832b151f` |
| rejected 截图 | `20917` bytes；SHA-256 `895a9fabd89078ac2dbe27b5fa6ac2b535fed5bc48381f61a427630d744a034a` |
| browser result | schema version 1、phase `browser-accepted`；SHA-256 `de758cff51591dfecc9470c2bc2d59e81b872e019ff77bf39f7e2eb92d6b4065` |

浏览器重启后的 API trace 共 22 条记录、11 个连续 entry/result 对；HMAC、sequence、文件身份、时间戳、PID role、handler/environment identity 和原始 requestId/key 脱敏检查违规均为 0。该次 `decide` 的 request hash 唯一对应 1 个 completed ledger entry 和 1 个 audit event。

浏览器验收后从安装态绝对 CLI 停止 daemon。daemon PID `45416`、API PID `70608` 均退出；端口 `52779` listener 为 0，daemon/API/heartbeat marker 为 0，本 run-id 拥有进程为 0。

## Fixture、manifest 与工作树边界

| 项目 | 结果 |
|---|---|
| 隔离 probe | detached `c992cc988614aaa5f2811c28aa090496cb936d68`；clean；remote 0；alternates 不存在 |
| Skill tree | `6e1c11aef5b7f969ecebb7201d3be5058e9268e3` |
| physical Skill content SHA-256 | `04a3cbe16c5317c25d873e00c19c4b10e9864be0ccdf400148776f8761824bc2` |
| Skill projection | 29 个 strict CRLF 项；SHA-256 `80a5676a76bafc6a8bb5a320749a9efc27f0672947fe0eddfa1a6f890d621481` |
| probe projection | 50 项；SHA-256 `a96f9ed0319a547a923992f542f31afb8cfc45caf993b8cfaa583b9f9efc5ada` |
| probe Git 结果 | HEAD、tracked diff、staged diff 不变；浏览器 reject 仅删除隔离 Hub 数据根下本 run-id 的合成 inbox 目录 |

P1 没有实现 P2/P3 的正式 snapshot 物化，因此这里记录的是 P0 兼容 fixture 的内容与投影摘要，不把它冒充未来的 `librarySnapshot`。

## 受保护根未受影响

- 固定 `E:\ozdqp-cli-attach-probe` 保持 detached `c992cc988614aaa5f2811c28aa090496cb936d68`，porcelain、tracked/staged 和 alternates 前后不变。该树在运行前已有 `origin`，remote 配置前后完全一致；不得把它描述成“无 remote”。
- 活 `E:\ozdqp-skill-hub` 保持 `master@cfe617738ada757e042526d127df546092bce6c2`，只保留运行前登记的四项无关脏状态：`skill-review/sessions.json`、`skill-review/state.json` 以及两个本地 docs 文件。state SHA-256 `3E4075B5FA670667732E1B20D85E0F2A7437562AD8464F81003F12A48492185C`，sessions SHA-256 `B1CBB9D25AB12568EC826015F97149A89A9AF336CAB7FAA34D20B2AF882E03BF`；内容、长度和 mtime 与运行前一致。
- 未修改任何 OZDQP 活工作树，也未读取或写入日常 DSH profile。

## 脱敏证据索引

| 原始证据 | SHA-256 |
|---|---|
| P1 Application summary | `70C74275B47064BA298498DCDC29D72B57C76330CF908EBEB46639075A218833` |
| browser acceptance metadata | `955B02D90EB7E55FCF8F2063C7A1EE3981005106831F8A1709F1956026A1F2E4` |
| browser result | `de758cff51591dfecc9470c2bc2d59e81b872e019ff77bf39f7e2eb92d6b4065` |

## 阶段边界

P1 范围内未验证项：无。

snapshot/pin 持久化、状态迁移和跨进程锁进入 P2；copy 物化与旧链接迁移进入 P3；完整 Local 发行与正式 Codex SessionRunner 进入 P4–P5；DSH bundle/UI/SessionRunner 进入 P6–P8；双宿主并存和发布候选进入 P9–P10。
