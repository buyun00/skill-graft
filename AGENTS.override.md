# OZDQP 本地 Codex 约定

## 任务路由

| 当前任务 | 必须使用的项目 Skill | 说明 |
| --- | --- | --- |
| 只读问答、讨论、状态说明 | 无 | 按需读取文件，不因项目上下文自动加载开发流程。 |
| 功能、Bug 修复、重构、代码、资源或配置变更 | `ozdqp-development` | 按理解、计划、实现、验证的流程执行。 |
| Unity UI、Prefab、UI 脚本、组件或序列化绑定变更 | `ozdqp-development` + `ozdqp-ui-development` | UI Skill 内部再区分完整规范化、定点检查和不触发组件规范。 |
| 读取或修改真实 Unity Editor 对象 | `unity-skills` | 通过 UnitySkills 本地 REST 服务执行；若同时涉及代码、资源或 UI 变更，与上面的项目 Skill 组合使用。 |
| Git 分类、提交、同步、分支或工作树操作 | `ozdqp-git-workflow` | 若 Git 是实现任务的收尾，只在进入 Git 操作阶段追加使用。 |

任务跨多个类型时只组合命中的 Skill，不预加载全部参考；只读诊断在用户要求修复前不自动升级为实现任务。

## Unity 操作后端

- 当前分支的 Unity 操作后端是 `UnitySkills` 本地 REST 服务；`ai-game-developer` MCP 已停用。
- 需要读取或修改真实 Unity 对象时，加载根目录的 `unity-skills`，按其握手、schema、dry-run 和权限门禁执行。
- `AGENTS.override.md` 是当前后端的唯一项目级真相来源；不得根据已安装的工具或 Skill 自行切换后端。
- 根入口 `.agents/skills/unity-skills` 是指向 `baloot_client/.agents/skills/unity-skills` 自动生成目录的 Junction；不要复制成第二份，也不要恢复旧 MCP 原子 Skill。
- 未取得 UnitySkills REST 服务的真实输出，不得把代码搜索或 Prefab 文本推测当成 Unity 侦察证据。

## Unity 验证约束

- 禁止 Codex 或其子代理运行 Unity Test Runner，包括 UnitySkills 的 `test_*` 能力、Unity Test Framework 命令行入口，以及通过菜单或窗口启动 EditMode/PlayMode 测试。
- 不得通过保存、丢弃或临时清除脏场景状态来绕过 Test Runner 的启动限制，也不得为此创建临时 Editor 辅助脚本。
- `Packages/com.yuetang-utility.core/Runtime/Main/Resources/Scene/Launcher.unity` 经常会产生与任务无关的脏状态；除非用户明确要求修改 Launcher，否则直接忽略，不检查差异、不保存、不还原、不清除脏标记，也不因此阻塞当前任务。
- Unity 变更应改用脚本编译状态、Console 错误、静态检查、项目自带的非 Test Runner 校验器，以及必要的真实对象只读检查完成验证。

## 本地 Skill 可见性

- 只加载与当前任务直接相关的 reference；不要恢复旧 Cursor、Claude Code、飞书或通知流程。
- 本分支额外启用 `unity-skills`；运行 `.codex/local-overlay/register-unity-skills.ps1` 可幂等恢复工作树根目录的注册入口。
- 3 Skill、`AGENTS.override.md` 与 overlay 的权威源是独立仓 `E:/ozdqp-skill-hub`。已挂接的游戏树只打链接，不持有副本。
- 旧 `.agents`、`.claude` 和 `.codex` 助手文件已从已挂接工作树本地移除；除 Git 同步临时恢复或用户明确要求外，不要恢复。
- `fetch`/`pull` 到的官方新 Skill 由 hook 写入中心仓 inbox。功能分支对话只提示打开 http://127.0.0.1:18765/ ，不要在分支里做语义归类或合入。

## 新工作树初始化

- 权威源：`git config --get ozdqp.localOverlaySource`（应为 `E:/ozdqp-skill-hub`）。
- 新签出的分支不要只跑脚本。在中心仓面板点「用 Codex 改用本地 Skill」，或把 `ozdqp.skillHubAutoAttach` 设为 true 后由 hook **拉起 Codex 对话**做剥离与挂接。对话须先侦察、等确认、再验收。
- 已有未挂接的旧 worktree 默认不自动处理。
- `unity-skills` 仍按游戏树单独注册，不进中心仓。
