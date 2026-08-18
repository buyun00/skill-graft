# ozdqp-skill-hub

本机客户端 Skill 中心仓。游戏仓 worktree 只挂链接，不持有 3 Skill 副本。

- 介绍与设计理念：`docs/系统设计与理念.md`
- 面板：`overlay/start-panel.ps1` → http://127.0.0.1:18765/
- 挂接当前树：`overlay/attach-library.ps1 -TargetWorktree <path> -ConfigureGit`
- 新树剥离/挂接必须经面板拉起的 Codex 对话，不要只跑脚本

不要把本仓文件提交进 ozdqp 游戏仓。
