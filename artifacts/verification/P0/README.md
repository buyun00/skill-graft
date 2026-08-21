# P0 基线冻结与真实测试隔离证据

## 结论

P0 于 2026-08-21 16:57 +08:00 完成。默认测试与真实测试已物理分离；默认套件使用临时 Hub、假 Runner 和临时 API，不调用活 Hub 业务/API，也不写受保护目录，只对其做只读指纹；真实套件必须通过显式开关、run-id marker、canonical path、Git 祖先、reparse point、受保护根和进程所有权门禁。当前 Local 行为已用重新打包并隔离安装的候选完成一次真实 Codex attach，以及一次真实 daemon/API/静态网页启动—停止验收。

- 源码基线：`cfe617738ada757e042526d127df546092bce6c2`
- 已验证实现提交：`a904ca27219f3d106f1365aa35a8e229650e2eee`
- 分支：`codex/skill-graft-dual-host`
- 最终 run-id：`p0-final-20260821-163343`
- 隔离根：`E:\skill-graft-e2e\p0-final-20260821-163343`
- 可机读源码基线：[baseline-inventory.json](./baseline-inventory.json)
- 原始日志策略：只保留在 marker 所有的隔离根，不提交；本文件仅保留脱敏字段与 SHA-256。

## 候选包与隔离安装

候选从最终提交的等价工作树执行 `npm pack`，随后以独立 HOME、APPDATA、LOCALAPPDATA 和 npm cache 强制覆盖安装到本轮 `app` 目录；真实 CLI 与 server 均从安装包运行，不从源码树运行。

| 项目 | 结果 |
|---|---|
| 包 | `ozdqp-skill-hub@0.1.0` |
| tarball | `ozdqp-skill-hub-0.1.0.tgz` |
| 大小 / 解包大小 | `668207` / `1833878` bytes |
| 条目数 | `195` |
| tarball SHA-256 | `C5274170C58BE1F29F1E2CB9385971C93E511199A9E0FE419B1C61A0E3E95327` |
| npm shasum | `6fc4c47a85a5b7e926bf419eb1156e2cf7df2cc1` |
| npm integrity | `sha512-XIsQVoYeQthwtmS5xIX+MSKfnyNOSt2/tR4RsJgfCBuc3Io9ZkJuF9NiNyd51pKgd8ZQRiVaynLbTKumxhR5QA==` |
| 安装后 CLI SHA-256 | `8B73D2AF563DC5E81BE9A39487008DDDE64B83BEC256C6A77CCF84A4EB1D1491` |
| 安装后 server SHA-256 | `6FF74E4B210307F57786BD1F4BDF0865454C12D918CB8A5B6C50688D9204F949` |
| 运行态/history 条目 | `0` |
| resident Skill 目录 | `0`；作为 P4/P10 自包含发行缺口保留 |

安装后的 `test/support/real-e2e.mjs` 与 `test/real/local/attach.test.mjs` 分别和最终源码 SHA-256 一致，证明最终清理门禁参与了真实验收。

## 自动化与合同验证

| 命令 | 结果 | 关键合同 |
|---|---|---|
| `npm run build` | 通过 | TypeScript 构建成功 |
| `npm run test:safety` | `9/9` 通过 | 活树、HOME、drive root、Git 祖先、Junction escape 均 fail closed；真实 Node 父子树和 detached PID 可回收 |
| `npm test` | `84/84` 通过 | 默认测试不可发现真实 attach；临时 Hub/假 Runner/假 API；固定 probe 使用 no-optional-locks 并做完整指纹 |
| 本轮隔离 daemon 停止后再次 `npm test` | `84/84` 通过 | 默认套件不依赖 daemon、DSH 或 Codex 凭据 |
| `npm pack` 后隔离安装 | 通过 | 真实验收只调用安装包 CLI/server；运行态文件未入包 |

默认套件前后对当前仓 `skill-review/**`、`overlay/**` 和固定 probe 的 HEAD、index bytes/mtime、stage、visibility、porcelain 做指纹比较。默认运行强制 `HUB_SPAWN_CODEX=0`，使用随机 loopback 假 API，不访问活端口 `18765`。

## 真实 Codex attach

命令为显式 `SKILL_GRAFT_REAL_E2E=1` 的 `npm run test:real:local:attach`；目标只允许本轮 marker 所有的隔离 probe。真实套件共 `2/2` 通过，总耗时约 `581.5s`，其中 attach 约 `573.9s`。

| 项目 | 结果 |
|---|---|
| attach 摘要 SHA-256 | `04225D9C67A215F0E3C39B744177DEC26234DCE82A50E57A2F076FC75E52D359` |
| Hub session ID SHA-256 | `9BD663A0DEC77187E6766BD6193EC294F184AB35B37AF657717A0C8A150EF287` |
| Codex session ID SHA-256 | `B86FEDE50FD2536B887B2C053FE9EE9403E50E54F2537C2B4CEFD57EAF7DC90B` |
| 会话结果 | `waiting`、exit code `0`、`gpt-5.6-luna`、effort `max` |
| 挂接结果 | `attached=true`、`overrideLinked=true`、`officialPresent=false` |
| probe HEAD | `c992cc988614aaa5f2811c28aa090496cb936d68`，detached，无 remote，HEAD 未变化 |
| Git 业务文件 | tracked diff `0`、staged diff `0` |
| 受控本地工作流文件 | `50` 个 untracked；非预期 `0` |
| legacy 可见性 | `571` 个允许的 skip-worktree 变化；非预期 `0` |

50 个受控文件由 `ozdqp-development` 6、`ozdqp-git-workflow` 6、`ozdqp-ui-development` 17、local overlay 20、`AGENTS.override.md` 1 构成。三个 Skill 与 local overlay 均为指向本轮隔离 `hub-data` 的 Junction；override 为与隔离 Hub 内容一致的 HardLink。因此准确结论是“tracked/staged clean，只有受控本地工作流物化”，不是“probe 完全 clean”。

`waiting + exitCode 0` 证明真实 Codex 会话已产生、完成一轮并可查询；它不替代 P5 的 attach/resume/cancel 完整生命周期验收。

## 真实 daemon、API 与网页

| 项目 | 结果 |
|---|---|
| daemon 摘要 SHA-256 | `6A3A232934B294D4C8C304419AF09FF52C4A9EB0EA23A7204885F3E575F4D5F3` |
| 随机端口 | `64907`；明确不使用 `18765` 或 `3080` |
| `/api/health` | HTTP `200`、`ok=true` |
| 静态网页 | HTTP `200`、`text/html; charset=utf-8` |
| daemon status | 10 次采样均 running；`apiHealthy` 约 `6.02s` 后收敛为 true |
| 停止与回收 | `stopped=true`、端口监听 `0`、PID 文件 `0`、摘要内 PID 全部退出 |
| run-id 残留进程 | `0` |

约 6 秒的 heartbeat 收敛延迟是已冻结的兼容行为，不等同于 API 启动失败。

## 受保护目录未受影响

`E:\ozdqp-cli-attach-probe` 仍为 detached `c992cc988614aaa5f2811c28aa090496cb936d68`，porcelain、tracked diff、staged diff 均为 `0`；原有 override SymbolicLink 与 resident Skill Junction 未变。

`E:\ozdqp-skill-hub` 仍为 `master@cfe617738ada757e042526d127df546092bce6c2`，只保留运行前已登记的四项用户/运行态状态：

- `M skill-review/sessions.json`
- `M skill-review/state.json`
- `?? docs/hub-panel-goal-prompt.md`
- `?? docs/launch-hub-panel-goal.cmd`

其中 sessions SHA-256 为 `B1CBB9D25AB12568EC826015F97149A89A9AF336CAB7FAA34D20B2AF882E03BF`，state SHA-256 为 `9355A45CF33F74C21EBD8B67E026FECFBD31A960CFC87B47F4B78F2E50782B90`；mtime 均早于最终 run 且哈希与运行前一致。活 `18765` health 仍为 HTTP `200`。运行前已存在的陈旧 `api.pid` 与真实 listener PID 不一致缺口未被本轮扩大。

## 失败尝试与修正

P0 中间真实运行曾暴露并修正以下问题，最终候选已全部重跑：

1. attach 会生成受控本地工作流文件，不能用“porcelain 必须为零”误判；改为 tracked/staged 零变化、允许列表完整分类且非预期为零。
2. API 已健康时 daemon heartbeat 仍可能短暂为 false；改为有界轮询到 running/apiHealthy 双真并保留采样。
3. scan root 必须指向 probe 的父目录才能按真实规则发现复制出的仓；fixture 已据此固定。
4. 大型 index visibility 输出需要显式大 buffer；否则会把采集失败误判为业务失败。
5. 代码复核发现 Git 祖先/Junction 逃逸、fixed probe 可选锁刷新、默认 doctor 访问活 API、detached PID 失败路径等风险；均补门禁和回归测试后重新打包、安装并执行本次最终真实验收。

## 已知缺口与阶段边界

以下是 P0 冻结出的后续工作，不是 P0 未验收项：

- 共享 Contracts/Core/Application 与直接 HTTP Application transport 尚不存在，进入 P1。
- snapshot/pin/锁、copy+marker 物化、本地自包含发行、完整 Local SessionRunner 分别进入 P2–P5。
- DSH bundle、DSH UI/Client/SessionRunner 与真实 DSH 会话尚不存在，进入 P6–P8。
- 当前包没有三个 resident Skill 目录，不能声称为最终自包含 Local 发行；在 P4/P10 关闭。
- legacy WMI Codex runner 的 Hub 状态与 probe 已 run-id 隔离，但认证和 Codex 客户端元数据仍使用现有用户 Codex home；在 P5 的正式 adapter/runner 边界关闭。
- 当前 daemon heartbeat 有约 6 秒收敛延迟，运行前活安装另有陈旧 `api.pid` 基线缺口。

P0 范围内未验证项：无。
