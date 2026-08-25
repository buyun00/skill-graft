# Skill Graft 工作树约定

此文件只提供通用的 Skill Graft 边界，不定义任何项目私有 Skill。项目规则仍以工作树自身的 `AGENTS.md`、用户指令和用户明确选择的 Skill 为准。

- 只使用当前工作树中由用户明确导入、选择或挂接的 Skill；未选择 Skill 时，不得从机器上的其他仓库、全局目录、历史会话或产品示例推断项目 Skill。
- `.agents/skills`、`.codex/local-overlay` 与本文件中的 Skill Graft 物化内容由 Skill Graft 管理；不要手写连接状态或伪造物化完成。
- 工作树原有且不属于 Skill Graft 的私有 Skill 与业务文件必须保留，不得因连接、同步、修复或解除连接而删除或接管。
- 任何写操作仍须遵守仓库自身的开发、验证与 Git 约定；Skill Graft 不授予额外的文件、提交或发布权限。
