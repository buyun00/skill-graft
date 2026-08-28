# Round014 跨层集成修复报告

## 结论

本轮跨层集成审查未发现需要追加补丁的明确缺口。Round014 的 7 个真实网页缺陷已逐项核对前端请求/响应字段、服务端持久化语义和面板状态门禁；执行级验证全部通过。

这份报告不把执行级验证升级为浏览器通过。Round014 的真实网页整轮仍为 FAIL，必须由新的独立 Sol Ultra 对话完成 Round015 复验。

## 缺陷闭环映射

| 缺陷 | 后端/持久化闭环 | 前端/交互闭环 | 集成结论 |
| --- | --- | --- | --- |
| SG-R014-001 聚焦编辑首次确认/保存状态不一致 | `/draft/confirm` 返回权威草稿和确认标志 | pointerdown 编辑快照、迟到 blur 吸收、draft/file refs 同步；提交前重读草稿 | 已闭环，需网页复验首次真实点击 |
| SG-R014-002 center-only 误用工作区融合语义 | center-only commit 的 `mergeReceipt` 固定为 `null` | 成功页按 receipt/origin 展示中心库语义；删除提示不提原工作区 | 已闭环，需网页复验文案 |
| SG-R014-003 刷新/历史 URL/versionId 回执变 0 文件 | 每版本 commit/merge sidecar，manifest、draft、state 同值；按 plan/version/draft/comparison 恢复 | overview/library hydration、receipt retention、旧路由替换使用持久回执 | 已闭环，需网页复验刷新/前进后退/旧 URL |
| SG-R014-004 AI cancel settlement 期间仍可输入 | 请求快照和取消会话保持同一 scope | 同步 input lock 覆盖 dispatch/cancel/settlement；late input/result 被 token 拒绝 | 已闭环，需网页复验结算期间输入 |
| SG-R014-005 1280×720 diff 字号低于 12px | 不涉及服务端 | diff 行号/正文/文件头/统计和流程摘要统一至少 12px；长行仅局部横滚 | 已闭环，需网页复验两视口 computed style |
| SG-R014-006 tombstone 人工确认误进 AI editable scope | originalContent echo 仅作不可变审阅；删除正文不可编辑，缺正文 fail-closed | 删除 tombstone 排除 AI 文件集，确认请求分离 `originalContent` 与编辑正文 | 已闭环；缺正文网页分支仍受 Round014 前置错误阻断，须复验 |
| SG-R014-007 首次 takeover confirm 被误判 stale | takeover hash 改用稳定物质内容/拓扑快照；真实变化仍 fail-closed | apply 从同步 approved preview ref 取值，避免旧 render/route snapshot | 已闭环，需网页复验首次确认 |

## 跨层核对重点

- 前端 `receiptFromCommit` / `normalizeReceiptForOrigin` 与服务端 `committed`、`merged`、`workspacePath` 契约一致；center-only 不会补造 workspace merge receipt。
- 服务端版本级 `commit-receipt.json` 与 `merge-receipt.json` 是权威副本，前端刷新时先读取 overview/library，再按查询中的 plan/version/draft identity 合并，不用 pending comparison 覆盖已持久化回执。
- 删除 tombstone 在服务端保持 `editable: true` 以便人工确认，同时以 `aiEditable: false` 排除 AI；页面只发送原文 echo，不把 tombstone 正文写回 draft body。
- takeover apply 的请求同时携带 `previewId`、`planHash`、`targetProjection`、`canonicalTarget` 和选中范围；服务端重新读取稳定快照，未发生真实变化才允许写入。
- save/commit 的写锁在成功导航前释放；AI cancel 控件与版本保存 busy 状态分离。

## 执行级验证

以下命令在当前工作树执行，未运行全套矩阵：

```text
node --check server/product-service.mjs
  PASS (exit code 0)

node --test test/product-service.test.mjs test/product-panel-contract.test.mjs
  PASS — 79 tests, 79 pass, 0 fail, 0 skipped
  duration: 24.426 s

npx tsc --noEmit -p panel/tsconfig.json
  PASS (exit code 0)

npm --prefix panel run build
  PASS — Next.js 14.2.35; compiled, type checked, 23/23 static pages generated

git diff --check -- server/product-service.mjs test/product-service.test.mjs panel/src/components/ProductApp.tsx panel/lib/editor-intent-flow.mjs panel/lib/product-route-flow.mjs panel/src/app/product.css test/product-panel-contract.test.mjs
  PASS (exit code 0; Git 仅提示 LF 将来可能转为 CRLF)
```

构建刷新了共享工作树中既有的 Panel/Web 生成输出；本轮没有手工清理或覆盖这些生成物，也没有改变其它既有 dirty/untracked 文件。

## 实际修改文件与边界

本轮整合确认的功能修改文件为：

- `server/product-service.mjs`
- `test/product-service.test.mjs`
- `panel/src/components/ProductApp.tsx`
- `panel/lib/editor-intent-flow.mjs`
- `panel/lib/product-route-flow.mjs`
- `panel/src/app/product.css`
- `test/product-panel-contract.test.mjs`

对应独立修复报告：`FIX-REPORT-BACKEND.md`、`FIX-REPORT-FRONTEND.md`。本集成回合只新增本报告，没有修改其它产品文件。

未做：Round015 真实浏览器 E2E、原生 Windows picker 成功返回、外部模型所有 late-session 时序、Unity Editor/设备/发布链路。Round014 已记录的 fixture/source/copy/Junction 保全证据仍以 `RUN-REPORT.md` 和 `FINAL-AUDIT.json` 为准。
