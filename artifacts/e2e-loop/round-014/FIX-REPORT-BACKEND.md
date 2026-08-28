# Round014 后端修复报告

## 范围

本轮只处理 Round014 真实浏览器暴露的服务端/持久化问题。没有进行浏览器 E2E、没有修改安装态/服务/隔离工作区/源树，也没有执行 Git 提交、推送、清理或重置。前端首击确认、AI 取消 settlement 输入锁和 1280×720 字体问题留待前端/网页复验。

## 缺陷 → 根因 → 修复 → 测试

| Round014 缺陷 | 根因 | 后端修复 | 回归覆盖 |
| --- | --- | --- | --- |
| SG-R014-003：刷新、历史 URL、`versionId` 后回执显示 0 文件 | commit 回执虽有 sidecar/state，但 merge 回执只在可变 state；版本 manifest 没有 version-local merge 回执，读取路由也只从当前状态推导 | 新增每版本 `merge-receipt.json`；workspace-review 将同一 merge 回执写入 sidecar、immutable manifest、draft、plan version entry、state；新增按 plan/version/draft/comparison 恢复逻辑，并支持只带 `versionId` 的旧 URL；`/overview`、`/library`、`/library/file`、`/comparison`、`/draft` 使用版本级权威回执；center-only 明确写入 `mergeReceipt: null` | `merged commit persists an authoritative receipt...`：磁盘 sidecar/manifest、历史 overview/library/file、comparison、重建 service 均验证；center-only manifest 无 merge sidecar/回执 |
| SG-R014-006：删除 tombstone 被当成 AI 可编辑文件，人工确认失败 | tombstone 只有通用 `editable` 标志，无法表达“可人工确认但正文不可 AI 改写”；confirm 也未接受明确的 original echo 字段 | tombstone 保持 review/AI 辅助说明可见，但增加 `aiEditable: false` 身份；AI 同步永远跳过删除正文；`/draft/confirm` 接受 `originalContent` echo，并只按 canonical 原文比较，绝不写 tombstone body；`/draft/file` 与缺正文门禁继续 fail-closed | `deleted tombstone accepts the page original echo...` 验证 original echo、`aiEditable=false`、不可编辑和提交；`deleted tombstone reaches manual review...` 验证 AI 无正文后转人工；missing-body 测试验证 draft/file/confirm/AI/commit/rollback 全部阻止 |
| SG-R014-007：首次 takeover confirm 被误判 stale | preview/apply 对完整 presentation 对象做 hash，路径大小写/排序/诊断元数据等非物质变化会造成假 stale | takeover hash 改为稳定物质快照：方案/版本/工作树/投影/规范目录/选中体系，以及排序后的操作路径、存在性、前后 hash、动作、脏状态和链接边界；忽略仅展示性字段；apply 仍重新读取实际目标，真实内容/拓扑变化继续 fail-closed | `internal Junction projection...` 先在预览后真实改变目标正文并断言 `PRODUCT_PLAN_STALE`，恢复后对同一预览首次 apply 成功；现有外部链接/拓扑/回滚测试继续通过 |

## 持久化语义

- `commit-receipt.json` 是每个版本的 commit 权威副本；manifest 和 state 只是兼容/索引副本。
- workspace-review 额外写 `merge-receipt.json`，并在版本 manifest、draft、plan version entry 与 state 保存相同值。按历史 version/draft/比较 ID 读取时优先版本副本；未带 plan 的 `versionId` 会遍历 durable plan index。
- center-only/manual commit 的 `mergeReceipt` 永远为 `null`，不继承上一个 workspace merge；rollback 版本不复制源版本的 commit/merge receipt。
- tombstone 的 `originalContent` 仅作人审阅回显。确认可以不带正文，也可以带 canonical 等价的 `originalContent`/页面 echo；任何不同正文都拒绝，且删除正文不能经 `/draft/file` 或 AI 导入写回。
- takeover 仍是 preview → apply 的 fail-closed 流程：稳定快照允许无外部变化的一次确认，真实文件、存在性、脏状态、链接拓扑或选中范围变化都会要求重新预览。

## 验证命令

以下均在当前工作树执行，未运行全套矩阵：

```text
node --check server/product-service.mjs
  exit code 0

node --test test/product-service.test.mjs
  38 tests, 38 pass, 0 fail, 0 skipped

git diff --check -- server/product-service.mjs test/product-service.test.mjs artifacts/e2e-loop/round-014/FIX-REPORT-BACKEND.md
  exit code 0
```

## 待真实网页复验边界

- 需要下一轮真实浏览器重新验证：首次聚焦编辑一次确认/保存、center-only 成功页文案、刷新/后退/前进/旧 URL 的最终页面展示、tombstone 页面确认路由、第一次 takeover 确认、AI 取消 settlement 输入锁及 1280×720 可读性。
- 本报告没有声称原生 Windows picker、外部模型 late-session timing、Unity Editor/设备/构建发布链路已验证。
