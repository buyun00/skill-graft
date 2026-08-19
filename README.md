# ozdqp-skill-hub

本机客户端 Skill 中心仓。游戏仓 worktree 只挂链接，不持有 3 Skill 副本。

- 介绍与设计理念：`docs/系统设计与理念.md`（第 9 节：适配 / 核心 / 控制）
- 本阶段三层规格（功能 / 接口 / 测试）：`docs/三层本阶段规格.md`
- 面板：`overlay/start-panel.ps1` → http://127.0.0.1:18765/
- 查询 CLI：`npm run hub -- status` / `list-worktrees` / `list-skills`
- 第一次挂接：`npm run hub -- attach --worktree <path>`（后台 Codex 对话，默认 luna max）
- HTTP / hook 只转发 CLI，不直接调核心

不要把本仓文件提交进 ozdqp 游戏仓。
