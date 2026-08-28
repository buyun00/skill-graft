# Round014 前端修复报告

## 范围与边界

本轮由当前对话直接完成，只修改了以下允许的前端/契约文件，并新增本报告：

- `panel/src/components/ProductApp.tsx`
- `panel/lib/editor-intent-flow.mjs`
- `panel/lib/product-route-flow.mjs`
- `panel/src/app/product.css`
- `test/product-panel-contract.test.mjs`
- `artifacts/e2e-loop/round-014/FIX-REPORT-FRONTEND.md`

没有运行浏览器 E2E、服务端测试或 panel build；没有修改安装态、服务、隔离工作区、源树或 Git 状态。共享工作树中其他既有 dirty/untracked 内容保持原样。

## 缺陷到修复与测试映射

| Round014 缺陷 | 根因 | 前端修复 | focused/contract 覆盖 |
| --- | --- | --- | --- |
| SG-R014-001 首次点击确认文件没有落到 draft manifest | textarea 的 blur 保存、按钮 click 和 React state 更新存在先后竞态；旧 blur 可能在确认后再次写入未确认状态 | `createEditorIntentQueue` 为当前文件/输入 token 记录已完成确认并吸收迟到 blur；确认按钮在 pointerdown 阶段保留当前编辑快照；`confirmFile` 发送最新正文、读取服务端返回的确认状态并同步 `draftRef`/`filesRef`；提交前重新读取 draft，服务端确认标志作为 manifest 门禁 | `focused confirmation atomically snapshots...`、`a blur arriving after confirmation settles...`、`focused textarea keeps the first real pointer click...`、`first confirmation...` |
| SG-R014-002 center-only 成功页显示“更新已合并/原工作区”，删除文案误导 | 中心库草稿与工作区融合共用成功页，但来源语义依赖旧的本地 flow/draft 状态 | `normalizeReceiptForOrigin`、`draftSaveSuccessPresentation` 和成功页优先使用持久 receipt/origin；中心库删除 tombstone 改为“中心库删除预览”，明确不修改工作区 | `center-only success presentation keeps center-library semantics...`、`draft save transaction freezes center-only origin...` |
| SG-R014-003 刷新、前进后退、旧 URL/versionId 成功页回退为 0 文件 | 成功页只依赖瞬时 overview/draft；版本 sidecar/commit receipt 未在路由恢复前完成 hydration | 从 overview、library、version、draft 和 commitReceipts 收集权威 receipt；按 plan/version/draft identity 保留 receipt/fileCount/origin；初始加载和 popstate 先刷新 overview/library 再解析终态路由，并把不完整结果 URL 替换为带 receipt 的地址 | `persisted receipts restore old result URLs...`、`receipt retention keeps the durable count...`、`merged route is exact...` |
| SG-R014-004 AI 取消 settlement 期间仍能输入 | `readOnly` 的 React render 晚于事件；取消 settlement 只锁异步状态，旧 render 仍可写 prompt | 新增同步 `aiInputLockRef`，在 dispatch、cancel、reset 和 settlement 失败期间立即锁定；prompt、文件勾选、导航和提交统一读取该锁；取消恢复只使用 request snapshot，终态才解锁 | `AI cancellation uses a synchronous input lock...`、`AI composer contract freezes...`、`interaction gates fail closed...` |
| SG-R014-005 1280×720 diff 文字小于 12px | diff 行、文件头和统计数字沿用 8–10px 紧凑样式 | 在 diff 局部覆盖中把行号/正文、文件头、统计和流程摘要统一提升到至少 12px；保留嵌套 `.github-diff` 的局部横向滚动，不扩大根级页面 | `product panel layout rules keep long paths...`（包含 `github-diff-line` 12px 断言） |
| SG-R014-006 tombstone 人工确认误进入 AI editable-range | 删除文件仍沿用普通正文编辑/AI 选择路径；确认请求没有区分“人工删除审阅”和“正文编辑” | 删除文件永远不进入 `isAiEditableFile`；正文不可用时按钮 fail-closed；有正文时只发送 `originalContent` 审阅回显，不把 tombstone 展示正文作为编辑 payload；中心库/工作区删除使用不同安全文案 | `tombstones remain human-review only while missing deletion bodies stay fail-closed`、AI editable-file contract |
| SG-R014-007 takeover 首次确认使用 stale preview | 选择目标投影后 React route snapshot 可能落后一帧，apply 读取旧比较对象，服务端因此认为预览已过期 | `comparisonRef` 在生成预览时同步保存当前 preview；apply 从同步 ref 读取 approved preview，并用返回结果合并保留已批准的路径/目标后再进入成功页 | `takeover apply preserves the approved paths while the request is busy`、`successful library and takeover writes release before success navigation` |

另外同步了 merge/library draft 的 `draftRef`、`filesRef`，使首次确认、AI 完成和保存提交都使用同一份当前草稿快照；保存阶段只显示版本保存状态，不显示 AI 取消控件。

## 验证命令与结果

在当前工作树执行：

```text
node --test test/product-panel-contract.test.mjs
41 tests, 41 pass, 0 fail, 0 skipped

npx tsc --noEmit -p panel/tsconfig.json
exit code 0

git diff --check -- panel/src/components/ProductApp.tsx panel/lib/editor-intent-flow.mjs panel/lib/product-route-flow.mjs panel/src/app/product.css test/product-panel-contract.test.mjs
exit code 0; no output
```

## 待真实网页复验边界

- 本轮没有启动或控制浏览器，因此不能把 focused contract 结果升级为 Round014 浏览器 PASS。
- 首次点击确认、刷新/前进后退/旧 URL receipt、AI 取消 settlement、1280×720 diff、tombstone 人工确认和 takeover 首次应用仍需在真实网页上复验。
- takeover 的 apply/preview 服务端契约以及持久 commit/merge receipt 以并行后端修复为前提；本轮没有修改 server，也没有运行 server tests。
- 未验证原生 Windows picker、外部 Junction、真实私有 Skill 保全和任何 Unity Editor/设备流程。
