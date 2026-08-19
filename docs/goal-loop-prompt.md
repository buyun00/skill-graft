# skill-graft 自动开发循环（给 Goal 会话用）

你在 `E:\ozdqp-skill-hub` 里做 **skill-graft** 的自动开发。需求源是 `docs/开发清单.md`。本文件是操作规程，清单是「做什么」，本文件是「怎么循环」。

不要进入 plan 模式。不要等人确认才动手。不要重做第 0 项。不要做第 10 项（多机 / 小团队）。

---

## 目标（Goal 完成条件）

第 1 至第 9 项全部勾选，每项都满足该步「完成才算完」，`docs/开发清单.md` 的「当前指针」已越过第 9 项（或写明 1–9 已完成），并且每一项都有一次对应的 git 提交且已 `git push origin master`。

独立验收时必须能复现：clone 后的运行时行为 + `npm test` 绿 + 清单勾选与提交信息对得上。没有测试输出、没有探针冒烟记录，不得声称完成。

---

## 硬规则（违反即停，不许绕过）

1. **CLI 是唯一命令面。** HTTP / hook / 以后的网页只 `exec` `sg` 或 `dist/control/cli.js`，禁止 `import` core。
2. **第一次切换走对话。** `attach` / `detach` / 第一次改挂禁止 CLI 或测试静默跑剥离脚本。
3. **权威源在 hub。** 禁止把 `skills/`（除 `skills/README.md`）、`skill-review/sessions.json`、session log、prompt、history 推进 GitHub。
4. **禁止改活树。** 冒烟只用 `E:\ozdqp-cli-attach-probe`，或新复制的稀疏 / 临时树。禁止改正在干活的游戏仓（例如 `E:\ozdqp-startup-download-trace`）。测试不得改 `ozdqp.gameRepo` 后不还原。
5. **`src/core` 禁止** `node:http`、`powershell.exe`、Win32、`APPDATA`。
6. **一次只做当前指针那一项。** 做完再下一项。不要并行开新子系统。
7. **禁止 `git push --force`**（除非远端明确要求且你能证明没有别人的提交会被丢掉；默认永远不用）。
8. 提交前看 `git status`：只暂存运行时 / 文档 / 测试。不要 `git add .`。

---

## 每一步的循环（必须按这个顺序）

对清单里的 **当前指针** 项 N（从 1 到 9）：

### A. 拉远程并合并

```text
git fetch origin
git pull --rebase origin master
```

- rebase 冲突：先试着解决；解决不了再 `git rebase --abort` 后 `git pull origin master`（merge）。
- 仍冲突：**停**，在对话里写清冲突文件和原因，不要假装做完。
- pull 完再读一遍 `docs/开发清单.md` 的指针，以磁盘为准（可能别人刚推了进度）。

### B. 实现

只读该项的「系统 / 目的 / 实现 / 自动化测试 / 真实冒烟 / 完成才算完」。只改完成该项所必需的文件。层边界见 `docs/系统设计与理念.md` 第 9 节。

### C. 自动验证

1. `npm test` 必须绿。红了就修，不要带着红测试往下走。
2. 再跑该项写明的自动化测试（若比全量更贴）。
3. 断言漏斗：`server/index.mjs` 与 hook 仍只 exec CLI。

### D. 真实冒烟

按该项「真实冒烟」在探针或临时目录上做。命令用 `sg`（没有则 `node dist/control/cli.js`）。

- 第 1 / 7 项若需要真 Codex：默认 `gpt-5.6-luna` + max，后台对话，**等到会话收尾**再验收。不要把「CLI 返回了 running」当成完成。
- 冒烟改坏了探针：重建 / 还原探针，不要去修活树。
- 把关键命令和结果写进该项提交说明或 `docs/开发清单.md` 该项下面一行「冒烟：…」（简短）。

### E. 存档点（git）

1. 勾选该项 `[x]`，把文首「当前指针」改成下一项（第 9 项做完则写「1–9 已完成」）。
2. `git status` / `git diff`，确认没有 skills、sessions、history、daemon pid、log。
3. 提交，说明写清做了清单第 N 项、测了什么。例如：

   `Complete checklist item N: <短标题>`

   正文写：实现要点、`npm test`、冒烟做了什么。

4. `git push origin master`。失败则 `git pull --rebase origin master` 再 push。还失败就停。

### F. 下一步

回到 A，做下一项。不要开新的 goal、不要等用户。

---

## 本机锚点

| 角色 | 路径 |
|---|---|
| hub | `E:\ozdqp-skill-hub` |
| 命令 | 新开逻辑下用 `sg`；本会话里也可用 `node dist/control/cli.js` |
| API | `http://127.0.0.1:18765` |
| 探针 | `E:\ozdqp-cli-attach-probe` |
| 远端 | `https://github.com/buyun00/skill-graft.git` 的 `master` |

`sg doctor` 应能跑。守护进程挂了就 `sg daemon start`，不要把装环境当成第 1 项。

---

## 项与依赖（不要跳）

```text
1 会话闭环
2 写盘链接端口
3 repair-links 收回核心
4 ingest 收回核心
5 decide 给已挂树补链接
6 认仓规则可配置
7 detach / edit 对齐
8 inbox 分析建议
9 新管理页
```

第 2 项是 3–5 的前提。第 1 项是后面所有真实会话冒烟的前提。第 6 项不要插到第 1 项前面。

---

## 卡住时

- 缺 Codex / 对话一直失败：把第 1、7 项里「必须真对话」的部分做到「假进程收尾 + 夹具测试绿」，在清单该项注明「真 Codex 冒烟未过：原因」，**不要勾完成**，停在该项。
- 只是测试红：修到绿，不要跳项。
- 范围膨胀：砍回当前项的「完成才算完」。

Claim 完成整个 Goal 之前，自己对照清单 1–9 的勾选、`git log origin/master` 里是否有对应提交、`npm test` 是否绿。缺一项就继续做，不要提前宣告。
