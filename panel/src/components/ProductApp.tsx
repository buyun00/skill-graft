"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPanelApi, createPanelRequestId } from "../../lib/api.mjs";
import { canMutateProductInput, canNavigateProduct, createAiComposerStateMachine, createAiInstructionState, createAiRequestGate, isAiComposerLocked, resetAiFileSelection, shouldShowAiCancel, transitionAiInstructionScope } from "../../lib/ai-flow.mjs";
import { analysisRecoveryRoute, analysisViewMode, normalizedAnalysisRetryPath } from "../../lib/analysis-flow.mjs";
import { DEFAULT_NEW_LIBRARY_FILE_CONTENT, completeLibraryDraft, isLibraryDraftOrigin, startNewLibraryDraft } from "../../lib/library-draft-flow.mjs";
import { invalidateLibraryDetail, preferredLibraryFile } from "../../lib/library-detail-flow.mjs";
import { acceptManualWorkspacePath } from "../../lib/manual-path-flow.mjs";
import { createEditorIntentQueue, preserveConfirmClickOnPointerDown } from "../../lib/editor-intent-flow.mjs";
import { formatProductError } from "../../lib/product-errors.mjs";
import { aiEditableFileIds, authoritativeProductReceipt, beginDraftSaveTransaction, draftSaveSuccessPresentation, isAiEditableFile, resolveDraftSavePresentation, resolveProductRoute, retainAuthoritativeReceipt, screenForProductPath } from "../../lib/product-route-flow.mjs";
import { WORKSPACE_RECHECK_BUSY_LABEL, workspaceRecheckPresentation } from "../../lib/recheck-flow.mjs";
import { resolvePersistedSelectionReference } from "../../lib/selection-flow.mjs";
import { preserveApprovedTakeoverPreview } from "../../lib/takeover-flow.mjs";
import { takeoverSummaryModel } from "../../lib/takeover-summary-flow.mjs";

type Dict = Record<string, any>;
type Screen =
  | "welcome"
  | "analysis"
  | "analysis-results"
  | "init-preview"
  | "init-success"
  | "home"
  | "connect-select"
  | "connect-mode"
  | "merge"
  | "merge-success"
  | "update-review"
  | "update-compare"
  | "update-result"
  | "update-success"
  | "takeover"
  | "takeover-success"
  | "library"
  | "workspaces"
  | "assistant"
  | "diagnostics"
  | "recovery";

type Flow = "initialize" | "connect" | "update";
type FlowVariant = "initialize" | "update" | "takeover" | "center";
type TakeoverStatus = "checking" | "active" | "rolled-back" | "unknown";
type NavigationAuthorization = "user" | "ai-success" | "cancel";
type ProductReceiptQuery = {
  planId?: string;
  versionId?: string;
  draftId?: string;
};
type Workspace = {
  path: string;
  name: string;
  summary?: string;
  status?: string;
  version?: string;
  hasChanges?: boolean;
  pendingAnalysisId?: string;
  pendingComparisonId?: string;
  lastAnalysisId?: string;
  planId?: string;
  baselineVersion?: string;
  baselineSignature?: string;
  baselineSafetySignature?: string;
  connectionMode?: string;
  protectionId?: string;
  selectedSystemIds?: string[];
  selectedSystemRefs?: Dict[];
  unresolvedSelectedSystemRefs?: Dict[];
  selectionNeedsReview?: boolean;
  selectionReviewMessage?: string;
  safetyBlocked?: boolean;
  connectionRecoveryRequired?: boolean;
};
type System = {
  id: string;
  name: string;
  technicalName?: string;
  kind?: string;
  subtitle: string;
  decision: string;
  confidence: string;
  skills: number;
  rules: number;
  badges: string[];
  explanation: string;
  sources: Array<{ kind: string; path: string }>;
  selectable?: boolean;
  blocked?: boolean;
  unavailableReason?: string;
  safeReason?: string;
  diagnosticPaths?: string[];
  sampleCount?: number;
  samplePaths?: string[];
  filePaths?: string[];
  sourcePath?: string;
  canonicalTarget?: string;
  contentHash?: string;
  sourcePaths?: string[];
  projections?: Dict[];
};
type ChangeFile = {
  id: string;
  path: string;
  skill: string;
  status: string;
  additions: number;
  deletions: number;
  diff: string;
  originalContent: string;
  finalContent: string;
  changedLines: number[];
  contentLoaded: boolean;
  confirmed?: boolean;
  editable?: boolean;
  deleted?: boolean;
  aiSkipped?: boolean;
  aiReviewNote?: string;
  direction?: string;
  resolutionRequired?: boolean;
  source?: string;
  originalContentAvailable?: boolean;
};
type ChatMessage = { role: "user" | "assistant"; body: string; proposal?: boolean };
type AnalysisFailure = { message: string; technical: string };

const api = createPanelApi().productApi;
const SKIP_INITIALIZATION_KEY = "skill-graft:skip-initialization";
const PRODUCT_RECEIPT_STORAGE_KEY = "skill-graft:product-commit-receipt";

function dict(value: unknown): Dict {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Dict : {};
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function first(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function stringValue(...values: unknown[]): string {
  const value = first(...values);
  return value == null ? "" : String(value);
}

function numberValue(...values: unknown[]): number {
  const value = first(...values);
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function readPersistedProductReceipt(): Dict | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(PRODUCT_RECEIPT_STORAGE_KEY) || "null");
    const receipt = authoritativeProductReceipt(value);
    return receipt ? dict(receipt) : null;
  } catch {
    return null;
  }
}

function persistProductReceipt(value: unknown): Dict | null {
  const receipt = authoritativeProductReceipt(value);
  if (!receipt || typeof window === "undefined") return receipt;
  try {
    window.localStorage.setItem(PRODUCT_RECEIPT_STORAGE_KEY, JSON.stringify(receipt));
  } catch {
    // The server receipt remains authoritative when browser storage is blocked.
  }
  return receipt;
}

function countLabel(value: unknown, fallback = "—"): string {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function basename(path: string): string {
  const parts = path.replaceAll("/", "\\").split("\\").filter(Boolean);
  return parts[parts.length - 1] || "未命名工作区";
}

function errorMessage(error: unknown): string {
  return formatProductError(error).message;
}

function errorTechnicalDetails(error: unknown): string {
  return formatProductError(error).technical;
}

function workspaceSummary(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return stringValue(value);
  const summary = dict(value);
  const systems = numberValue(summary.systems);
  const files = numberValue(summary.changedFiles, summary.files);
  const skills = numberValue(summary.skills, summary.active);
  const parts = [
    systems ? `${systems} 类内容` : "",
    skills ? `${skills} 个可用体系` : "",
    files ? `${files} 个文件` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function workspaceStatusLabel(value: unknown): string {
  const status = stringValue(value).trim();
  if (!status) return "已连接";
  if (/[一-鿿]/.test(status)) return status;
  switch (status.toLowerCase()) {
    case "connected":
    case "attached":
    case "active":
    case "synced":
      return "已连接";
    case "connected-with-updates":
      return "已连接 · 有新修改";
    case "connected-safety-blocked":
      return "安全阻止";
    case "connected-selection-review":
      return "需要确认范围";
    case "needs-connection":
      return "需要完成连接";
    case "observed":
    case "discovered":
    case "analyzed":
    case "pending":
      return "待连接";
    case "observed-safety-blocked":
      return "安全阻止";
    case "observed-selection-review":
      return "需要确认范围";
    case "failed":
    case "error":
      return "需要处理";
    case "disconnected":
    case "detached":
      return "未连接";
    default:
      return "已记录";
  }
}

function workspaceCardStatus(workspace: Workspace): string {
  if (workspace.connectionRecoveryRequired) return "需要完成连接";
  if (workspace.safetyBlocked) return "安全阻止";
  if (workspace.selectionNeedsReview) return "需要确认范围";
  if (workspace.hasChanges) return "有新修改";
  return workspace.status || "已连接";
}

function capabilitySystemName(value: string): string {
  if (/unityskills\s+rest/iu.test(value)) return "项目技能体系";
  if (/unity\s+mcp\s+cli/iu.test(value)) return "项目工具能力";
  if (/\b(?:rest|cli)\b/iu.test(value)) return value.replace(/\s+(?:rest|cli)\b/iu, "").trim() || "项目能力";
  return value;
}

function workspaceFrom(value: unknown): Workspace {
  if (typeof value === "string") return { path: value, name: basename(value) };
  const source = dict(value);
  const path = stringValue(source.path, source.workspacePath, source.worktreePath, source.root);
  return {
    path,
    name: stringValue(source.name, path ? basename(path) : "未命名工作区"),
    summary: workspaceSummary(first(source.summary, source.pendingSummary, source.description)),
    status: workspaceStatusLabel(first(source.status, source.state)),
    version: stringValue(source.version, source.currentVersion),
    hasChanges: Boolean(first(source.hasChanges, source.hasUpdates, source.pendingChanges, source.updateCount, source.updatesCount)),
    pendingAnalysisId: stringValue(source.pendingAnalysisId),
    pendingComparisonId: stringValue(source.pendingComparisonId),
    lastAnalysisId: stringValue(source.lastAnalysisId),
    planId: stringValue(source.planId),
    baselineVersion: stringValue(source.baselineVersion, source.connectedVersion),
    baselineSignature: stringValue(source.baselineSignature),
    baselineSafetySignature: stringValue(source.baselineSafetySignature),
    connectionMode: stringValue(source.connectionMode),
    protectionId: stringValue(source.protectionId),
    selectedSystemIds: array(source.selectedSystemIds).map(String),
    selectedSystemRefs: array(source.selectedSystemRefs).map(dict),
    unresolvedSelectedSystemRefs: array(source.unresolvedSelectedSystemRefs).map(dict),
    selectionNeedsReview: Boolean(source.selectionNeedsReview),
    selectionReviewMessage: stringValue(source.selectionReviewMessage),
    safetyBlocked: Boolean(source.safetyBlocked),
    connectionRecoveryRequired: Boolean(source.connectionRecoveryRequired),
  };
}

function stablePathKey(value: unknown): string {
  return String(value || "").trim().replaceAll("\\", "/").replace(/\/+$/u, "").toLocaleLowerCase("en-US");
}

function authoritativeTakeoverWorkspace(worktrees: unknown, expectedPath: string): Workspace | null {
  const candidates = array(worktrees).map(workspaceFrom).filter((tree) => Boolean(tree.path));
  const expected = stablePathKey(expectedPath);
  if (expected) {
    const matches = candidates.filter((tree) => stablePathKey(tree.path) === expected);
    return matches.length === 1 ? matches[0] : null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function systemSourcePaths(system: System): string[] {
  const row = dict(system);
  const projections = array(row.projections).map(dict);
  return [...new Set([
    row.sourcePath,
    row.canonicalTarget,
    ...array(row.sourcePaths),
    ...projections.flatMap((projection) => [projection.path, projection.sourcePath, projection.canonicalTarget]),
  ].map(stablePathKey).filter(Boolean))];
}

function hasPersistedSystemScope(target: Workspace): boolean {
  return array(target.selectedSystemIds).length > 0 || array(target.selectedSystemRefs).length > 0 || array(target.unresolvedSelectedSystemRefs).length > 0;
}

function preservedSystemIds(target: Workspace, nextSystems: System[]): string[] {
  const persistedIds = array(target.selectedSystemIds).map(String).filter(Boolean);
  const refs = array(target.selectedSystemRefs).map(dict);
  const references: Dict[] = [
    ...refs,
    ...persistedIds.filter((id) => !refs.some((ref) => stringValue(ref.id) === id)).map((id) => ({ id })),
  ].map(dict);
  const matchedIds: string[] = [];
  const used = new Set<string>();
  for (const ref of references) {
    const candidates = nextSystems.filter((item) => !used.has(item.id)).map((item) => ({
      ...item,
      sourceKeys: systemSourcePaths(item),
      paths: array(item.filePaths),
      fingerprint: item.contentHash || "",
    }));
    const result = resolvePersistedSelectionReference(ref, candidates);
    if (result.match) {
      const match = result.match as System;
      matchedIds.push(match.id);
      used.add(match.id);
    }
  }
  return Array.from(new Set(matchedIds));
}

function normalizeOverview(value: unknown): Dict {
  const raw = dict(value);
  const library = dict(first(raw.library, raw.centralLibrary, raw.centerLibrary));
  const version = dict(raw.version);
  const draft = dict(raw.draft);
  const libraryVersion = dict(library.version);
  const productReceipt = [
    raw.productReceipt,
    raw.mergeReceipt,
    raw.commitReceipt,
    ...array(raw.commitReceipts),
    version.mergeReceipt,
    version.commitReceipt,
    draft.mergeReceipt,
    draft.commitReceipt,
    library.productReceipt,
    library.mergeReceipt,
    library.commitReceipt,
    libraryVersion.mergeReceipt,
    libraryVersion.commitReceipt,
  ]
    .map((candidate) => authoritativeProductReceipt(candidate))
    .find(Boolean) || null;
  const counts = dict(raw.counts);
  const worktrees = array(first(raw.worktrees, raw.connectedWorktrees, raw.workspaces, raw.trees)).map(workspaceFrom);
  const changes = array(first(raw.pendingChanges, raw.updates, raw.changes, raw.items));
  // The overview endpoint intentionally keeps update details on each connected
  // worktree.  Turn those flags into navigable cards so the home page can show
  // a useful "new changes" entry without inventing fixture data.
  if (!changes.length) {
    changes.push(...worktrees.filter((tree) => tree.hasChanges).map((tree) => ({
      workspace: tree,
      worktree: tree,
      path: tree.path,
      name: tree.name,
      summary: tree.summary || "已连接工作树有新的 Skill 修改",
    })));
  }
  const plansPayload = array(raw.plans);
  const skills = first(raw.skillCount, raw.skillsCount, library.skillCount, counts.skills, array(library.skills).length || undefined);
  const plans = first(raw.planCount, raw.libraryCount, raw.schemeCount, counts.plans, plansPayload.length || undefined, array(library.systems).length || undefined);
  return {
    ...raw,
    library,
    counts,
    initialized: Boolean(first(raw.initialized, raw.hasLibrary, raw.libraryInitialized, library.initialized, raw.activePlanId, plansPayload.length ? true : undefined)),
    skillCount: skills,
    planCount: plans,
    worktrees,
    changes,
    currentVersion: first(raw.currentVersion, raw.version, library.currentVersion, library.version),
    libraryName: stringValue(raw.libraryName, library.name, "中心库"),
    hubRoot: stringValue(raw.hubRoot, library.root),
    productReceipt,
    mergeReceipt: stringValue(productReceipt?.status).toLowerCase() === "merged" ? productReceipt : null,
    commitReceipt: stringValue(productReceipt?.status).toLowerCase() === "committed" ? productReceipt : null,
  };
}

function normalizeSystems(value: unknown): System[] {
  const raw = dict(value);
  const nested = dict(first(raw.analysis, raw.result, raw.data, raw.plan));
  const source = array(first(raw.systems, raw.selectedSystems, raw.candidates, raw.groups, nested.systems, nested.selectedSystems, nested.candidates));
  if (!source.length && dict(raw.current).files) {
    source.push({ id: "current-library", name: stringValue(raw.plan?.name, "中心库内容"), summary: "当前中心库版本", status: "active", files: raw.current.files });
  }
  return source.map((item, index) => {
    const row = dict(item);
    const fileRows = array(row.files).map(dict);
    const sources = array(first(row.sources, row.provenance, row.origins)).map((entry) => {
      const sourceRow = dict(entry);
      return {
        kind: stringValue(sourceRow.kind, sourceRow.type, "来源"),
        path: stringValue(sourceRow.path, sourceRow.location, sourceRow.source),
      };
    });
    if (!sources.length) {
      sources.push(...array(row.projections).map((entry) => {
        const projection = dict(entry);
        return {
          kind: stringValue(projection.host, projection.kind, "投影"),
          path: stringValue(projection.path, projection.sourcePath, projection.canonicalTarget),
        };
      }));
    }
    const id = stringValue(row.id, row.key, row.slug, `system-${index + 1}`);
    const status = stringValue(row.status, row.decision, row.recommendation, "candidate");
    const technicalName = stringValue(row.name, row.title, id);
    const inferredSkills = new Set(fileRows
      .map((file) => stringValue(file.path, file.name))
      .filter((path) => /(?:^|\/)SKILL\.md$/i.test(path))).size;
    const inferredRules = fileRows
      .map((file) => stringValue(file.path, file.name))
      .filter((path) => /(?:AGENTS|CLAUDE)(?:\.|$)/i.test(path)).length;
    return {
      id,
      name: capabilitySystemName(technicalName),
      technicalName,
      subtitle: stringValue(row.subtitle, row.description, row.summary),
      decision: status,
      confidence: stringValue(row.confidence, row.confidenceLabel, "待确认"),
      skills: numberValue(row.skills, row.skillCount, row.fileCount && inferredSkills, inferredSkills),
      rules: numberValue(row.rules, row.ruleCount, row.counts && dict(row.counts).rules, inferredRules),
      badges: array(first(row.badges, row.labels, row.tags)).map(String),
      explanation: stringValue(row.explanation, row.reason, row.note),
      sources,
      kind: stringValue(row.kind, row.type),
      selectable: row.selectable !== false,
      blocked: Boolean(row.blocked || row.unavailableReason),
      unavailableReason: stringValue(row.unavailableReason),
      safeReason: stringValue(row.safeReason),
      diagnosticPaths: array(row.diagnosticPaths).map(String),
      sampleCount: numberValue(row.sampleCount),
      samplePaths: array(first(row.samplePaths, row.missingPaths)).map(String).filter(Boolean).slice(0, 120),
      filePaths: fileRows.map((file) => stringValue(file.logicalPath, file.path)).filter(Boolean),
      sourcePath: stringValue(row.sourcePath),
      canonicalTarget: stringValue(row.canonicalTarget),
      contentHash: stringValue(row.contentHash),
      sourcePaths: array(row.sourcePaths).map(String).filter(Boolean),
      projections: array(row.projections).map(dict),
    };
  });
}

function normalizeFiles(value: unknown): ChangeFile[] {
  const raw = dict(value);
  const nested = dict(first(raw.comparison, raw.draft, raw.result, raw.current, raw.version, raw.data));
  const source = array(first(raw.files, raw.changes, nested.files, nested.changes));
  if (!source.length && raw.file && typeof raw.file === "object") {
    source.push({ ...dict(raw.file), ...(raw.content !== undefined ? { content: raw.content } : {}) });
  }
  if (!source.length && raw.path && (raw.content !== undefined || raw.finalContent !== undefined)) source.push(raw);
  return source.map((item, index) => {
    const row = dict(item);
    const contentLoaded = ["finalContent", "newContent", "after", "content"]
      .some((key) => Object.prototype.hasOwnProperty.call(row, key));
    const original = stringValue(row.originalContent, row.oldContent, row.before, row.base, row.contentBefore);
    const finalContent = row.finalContent !== undefined
      ? String(row.finalContent)
      : row.newContent !== undefined
        ? String(row.newContent)
        : row.after !== undefined
          ? String(row.after)
          : row.content !== undefined
            ? String(row.content)
            : original;
    const changedLines = array(first(row.changedLines, row.modifiedLines)).map(Number).filter(Number.isFinite);
    const diffValue = first(row.diff, row.patch, row.unifiedDiff);
    const diffRows = array(diffValue).map(dict);
    const diffLines = typeof diffValue === "string" ? diffValue.split("\n") : diffRows.map((line) => `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${stringValue(line.text)}`);
    const additions = numberValue(row.additions, row.added, row.addedLines) || diffRows.filter((line) => line.type === "add").length || diffLines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = numberValue(row.deletions, row.removed, row.deletedLines) || diffRows.filter((line) => line.type === "remove").length || diffLines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const inferredChangedLines = diffRows.map((line) => Number(first(line.newLine, line.line))).filter((line) => Number.isFinite(line) && line > 0 && diffRows.some((rowLine) => rowLine.newLine === line && rowLine.type === "add"));
    const filePath = stringValue(row.path, row.file, row.name, `文件 ${index + 1}`);
    const pathParts = filePath.replaceAll("\\", "/").split("/").filter(Boolean);
    const skillIndex = pathParts.findIndex((part) => part.toLowerCase() === "skills");
    const inferredSkill = skillIndex >= 0 && pathParts[skillIndex + 1]
      ? pathParts[skillIndex + 1]
      : pathParts.length > 1 ? pathParts[pathParts.length - 2] : "未归类";
    return {
      id: stringValue(row.id, row.fileId, row.path, `file-${index + 1}`),
      path: filePath,
      skill: stringValue(row.skill, row.skillName, inferredSkill),
      status: stringValue(row.status, row.changeType, "修改"),
      additions,
      deletions,
      diff: diffLines.join("\n"),
      originalContent: original,
      finalContent,
      changedLines: changedLines.length ? changedLines : inferredChangedLines,
      contentLoaded,
      confirmed: typeof row.confirmed === "boolean" ? row.confirmed : undefined,
      editable: typeof row.editable === "boolean" ? row.editable : undefined,
      deleted: Boolean(row.deleted),
      originalContentAvailable: typeof row.originalContentAvailable === "boolean"
        ? row.originalContentAvailable
        : !row.deleted || (typeof row.originalContent === "string" && row.originalContent.length > 0),
      aiSkipped: Boolean(row.aiSkipped),
      aiReviewNote: stringValue(row.aiReviewNote, row.reviewNote),
      direction: stringValue(row.direction, row.changeDirection),
      resolutionRequired: Boolean(row.resolutionRequired || row.requiresResolution),
      source: stringValue(row.source, row.origin, row.contentSource?.kind),
    };
  });
}

function mergeDraftFiles(current: ChangeFile[], records: ChangeFile[]): ChangeFile[] {
  if (!records.length) return current;
  if (!current.length) return records;
  const byPath = new Map(records.map((record) => [record.path, record]));
  const byId = new Map(records.map((record) => [record.id, record]));
  return current.map((file) => {
    const record = byPath.get(file.path) || byId.get(file.id);
    if (!record) return file;
    return {
      ...file,
      id: record.id || file.id,
      finalContent: record.contentLoaded ? record.finalContent : file.finalContent,
      originalContent: record.originalContent || file.originalContent,
      originalContentAvailable: record.originalContentAvailable ?? file.originalContentAvailable,
      diff: record.diff || file.diff,
      additions: record.additions || file.additions,
      deletions: record.deletions || file.deletions,
      contentLoaded: file.contentLoaded || record.contentLoaded,
      confirmed: record.confirmed ?? file.confirmed,
      editable: record.editable ?? file.editable,
      deleted: record.deleted ?? file.deleted,
      aiSkipped: record.aiSkipped ?? file.aiSkipped,
      aiReviewNote: record.aiReviewNote || file.aiReviewNote,
      direction: record.direction || file.direction,
      resolutionRequired: record.resolutionRequired ?? file.resolutionRequired,
    };
  });
}

function summarizeChangedSkills(files: ChangeFile[]): Dict[] {
  const groups = new Map<string, ChangeFile[]>();
  for (const file of files) groups.set(file.skill, [...(groups.get(file.skill) || []), file]);
  return Array.from(groups.entries()).map(([skill, changed]) => {
    const additions = changed.reduce((sum, file) => sum + file.additions, 0);
    const deletions = changed.reduce((sum, file) => sum + file.deletions, 0);
    const kinds = Array.from(new Set(changed.map((file) => file.status))).join("、");
    return {
      id: `changed-skill-${skill}`,
      name: skill,
      path: changed.map((file) => file.path).join("、"),
      summary: `${changed.length} 个文件 · ${kinds || "修改"} · 新增 ${additions} 行，删除 ${deletions} 行`,
    };
  });
}

function payloadId(value: unknown): string {
  const raw = dict(value);
  const nested = dict(first(raw.draft, raw.result, raw.data));
  return stringValue(raw.draftId, raw.id, nested.draftId, nested.id);
}

function receiptFromCommit(value: unknown, origin: string, fallback: Dict = {}): Dict | null {
  const raw = dict(value);
  const draft = dict(raw.draft);
  const plan = dict(raw.plan);
  const version = dict(raw.version);
  const returned = [
    raw.productReceipt,
    raw.mergeReceipt,
    raw.commitReceipt,
    draft.mergeReceipt,
    draft.commitReceipt,
    version.mergeReceipt,
    version.commitReceipt,
  ]
    .map((candidate) => normalizeReceiptForOrigin(candidate, origin, fallback))
    .find(Boolean);
  if (returned) return dict(returned);
  const planId = stringValue(draft.planId, plan.planId, raw.planId, fallback.planId);
  const versionId = stringValue(version.versionId, plan.currentVersion, draft.committedVersion, raw.versionId, fallback.versionId);
  const status = isLibraryDraftOrigin(origin) ? "committed" : "merged";
  const workspacePath = stringValue(raw.workspacePath, raw.worktreePath, dict(raw.workspace).path, fallback.workspacePath);
  if (!planId || !versionId || (status === "merged" && !workspacePath)) return null;
  const returnedFiles = array(draft.files).length || array(version.files).length || numberValue(raw.fileCount, draft.fileCount, version.fileCount, fallback.fileCount);
  return normalizeReceiptForOrigin({
    status,
    planId,
    versionId,
    ...(workspacePath ? { workspacePath } : {}),
    draftId: stringValue(draft.draftId, raw.draftId, fallback.draftId),
    fileCount: returnedFiles,
    origin,
    createdAt: stringValue(version.createdAt, draft.updatedAt, raw.createdAt, new Date().toISOString()),
  }, origin, fallback);
}

function normalizeReceiptForOrigin(value: unknown, origin: string, fallback: Dict = {}): Dict | null {
  const raw = dict(value);
  if (!stringValue(raw.planId, fallback.planId) || !stringValue(raw.versionId, fallback.versionId)) return null;
  const rawStatus = stringValue(raw.status).toLowerCase();
  if (rawStatus && !["merged", "committed"].includes(rawStatus)) return null;
  const centerOnly = isLibraryDraftOrigin(origin);
  const normalized: Dict = {
    ...raw,
    status: centerOnly ? "committed" : "merged",
    planId: stringValue(raw.planId, fallback.planId),
    versionId: stringValue(raw.versionId, fallback.versionId),
    ...(origin ? { origin } : {}),
  };
  if (centerOnly) delete normalized.workspacePath;
  else if (!stringValue(normalized.workspacePath)) {
    const workspacePath = stringValue(fallback.workspacePath);
    if (workspacePath) normalized.workspacePath = workspacePath;
  }
  return authoritativeProductReceipt(normalized);
}

function productReceiptQuery(search: string): ProductReceiptQuery {
  const params = new URLSearchParams(search || "");
  return {
    planId: params.get("planId") || "",
    versionId: params.get("versionId") || params.get("version") || "",
    draftId: params.get("draftId") || "",
  };
}

function hasProductReceiptQuery(query: ProductReceiptQuery): boolean {
  return Boolean(query.planId || query.versionId || query.draftId);
}

function receiptMatchesQuery(receipt: Dict | null | undefined, query: ProductReceiptQuery): boolean {
  if (!receipt) return false;
  if (query.planId && stringValue(receipt.planId) !== query.planId) return false;
  if (query.versionId && stringValue(receipt.versionId) !== query.versionId) return false;
  if (query.draftId && stringValue(receipt.draftId) !== query.draftId) return false;
  return true;
}

function pathFor(screen: Screen, receipt: Dict | null = null): string {
  const mapping: Record<Screen, string> = {
    welcome: "/setup",
    analysis: "/setup/analysis",
    "analysis-results": "/setup/results",
    "init-preview": "/setup/preview",
    "init-success": "/setup/success",
    home: "/",
    "connect-select": "/workspaces/connect",
    "connect-mode": "/workspaces/connect/mode",
    merge: "/workspaces/connect/merge",
    "merge-success": "/workspaces/connect/merged",
    "update-review": "/changes",
    "update-compare": "/changes/compare",
    "update-result": "/changes/result",
    "update-success": "/changes/success",
    takeover: "/workspaces/connect/takeover",
    "takeover-success": "/workspaces/connect/taken-over",
    library: "/library",
    workspaces: "/workspaces",
    assistant: "/assistant",
    diagnostics: "/diagnostics",
    recovery: "/recovery",
  };
  const path = mapping[screen];
  if (!receipt || !["merge-success", "update-success"].includes(screen)) return path;
  const query = new URLSearchParams();
  for (const key of ["planId", "versionId", "draftId"]) {
    const value = receipt[key];
    if (value != null && value !== "") query.set(key, String(value));
  }
  return query.toString() ? `${path}?${query.toString()}` : path;
}

function screenForPath(pathname: string): Screen {
  return screenForProductPath(pathname) as Screen;
}

function changedLineNumbers(file: ChangeFile, content: string): Set<number> {
  if (file.changedLines.length) return new Set(file.changedLines);
  const before = file.originalContent.split("\n");
  const after = content.split("\n");
  const changed = new Set<number>();
  after.forEach((line, index) => {
    if (line !== before[index]) changed.add(index + 1);
  });
  return changed;
}

function abortError(): Error {
  const error = new Error("AI request was cancelled");
  error.name = "AbortError";
  return error;
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    timer = window.setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function waitForUiSettlementBoundary(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve().then(() => undefined);
  return new Promise((resolve) => {
    const finish = () => { void Promise.resolve().then(resolve); };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(finish);
    else window.setTimeout(finish, 0);
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTransientChatStatusError(error: unknown): boolean {
  const row = dict(error);
  const data = dict(row.data);
  const nestedError = dict(data.error);
  const detail = [
    errorMessage(error),
    stringValue(row.code),
    stringValue(data.code),
    stringValue(nestedError.code),
    stringValue(nestedError.message),
  ].join(" ");
  return /(?:write transaction failed|write lock is busy|lock[_ -]?busy|transaction (?:failed|busy|locked)|temporar(?:y|ily) unavailable|service unavailable|database is locked|request is already in progress|port[_ -]?failure|HTTP\s*50[23])/i.test(detail);
}

async function readChatStatusWithRetry(sessionId: string, signal?: AbortSignal): Promise<Dict> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (signal?.aborted) throw abortError();
    try {
      return dict(await api.chatStatus(sessionId, { signal }));
    } catch (caught) {
      lastError = caught;
      if (signal?.aborted || isAbortError(caught)) throw abortError();
      if (!isTransientChatStatusError(caught) || attempt === 4) throw caught;
      await waitFor(1000, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("暂时无法读取 AI 状态。");
}

function Brand({ compact = false, onClick }: { compact?: boolean; onClick?: () => void }) {
  return (
    <button className={`brand ${compact ? "brand-compact" : ""}`} type="button" onClick={onClick} aria-label="Skill Graft 首页">
      <span className="brand-mark" aria-hidden="true">S</span>
      <span>Skill Graft</span>
    </button>
  );
}

function WizardSteps({ active, update = false, variant }: { active: number; update?: boolean; variant?: FlowVariant }) {
  const mode = variant || (update ? "update" : "initialize");
  const labels = mode === "update"
    ? ["查看 Skill 修改", "处理文件差异", "审阅最终结果"]
    : mode === "takeover"
      ? ["选择工作区", "只读分析", "选择连接方式", "预览并接管"]
      : mode === "center"
        ? ["选择文件", "编辑中心库草稿", "审阅并保存"]
        : ["选择工作区", "只读分析", "确认项目方案", "创建方案"];
  return (
    <ol className={`wizard-steps ${mode === "update" ? "update-steps" : ""}`} aria-label={mode === "takeover" ? "接管处理进度" : mode === "center" ? "中心库编辑进度" : mode === "update" ? "更新处理进度" : "初始化进度"}>
      {labels.map((label, index) => (
        <li className={index + 1 < active ? "done" : index + 1 === active ? "active" : ""} key={label}>
          <span>{index + 1 < active ? "✓" : index + 1}</span>
          <small>{label}</small>
        </li>
      ))}
    </ol>
  );
}

function FlowChrome({
  children,
  title,
  subtitle,
  activeStep,
  update = false,
  variant,
  editable = false,
  onCancel,
}: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
  activeStep: number;
  update?: boolean;
  variant?: FlowVariant;
  editable?: boolean;
  onCancel: () => void;
}) {
  const resolvedVariant = variant || (subtitle.startsWith("中心库编辑") ? "center" : update ? "update" : "initialize");
  return (
    <main className="flow-shell">
      <header className="flow-header">
        <div className="flow-brand"><Brand compact onClick={onCancel} /><span className="context-chip">Skill Graft</span></div>
        <button className="icon-button close-button" type="button" onClick={onCancel} aria-label="取消并退出">×</button>
      </header>
      <div className="flow-progress"><WizardSteps active={activeStep} update={update} variant={resolvedVariant} /></div>
      <section className="flow-heading">
        <div><p className="eyebrow">{subtitle}</p><h1>{title}</h1></div>
        <span className={editable ? "draft-pill" : "readonly-pill"}><i /> {editable ? "可编辑草稿" : update && activeStep === 2 ? "尚未写入" : "当前只读"}</span>
      </section>
      {children}
    </main>
  );
}

export function ProductApp() {
  const [screen, setScreen] = useState<Screen>("home");
  const [flow, setFlow] = useState<Flow>("initialize");
  const [overview, setOverview] = useState<Dict | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [manualWorkspacePath, setManualWorkspacePath] = useState("");
  const [manualPathOpen, setManualPathOpen] = useState(false);
  const [analysis, setAnalysis] = useState<Dict | null>(null);
  const [systems, setSystems] = useState<System[]>([]);
  const [selectedSystems, setSelectedSystems] = useState<Set<string>>(new Set());
  const [library, setLibrary] = useState<Dict | null>(null);
  const [libraryTab, setLibraryTab] = useState<"systems" | "files" | "history">("systems");
  const [librarySearch, setLibrarySearch] = useState("");
  const [globalSearch, setGlobalSearch] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState<Dict[]>([]);
  const [newDraftOpen, setNewDraftOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [newFileContent, setNewFileContent] = useState(DEFAULT_NEW_LIBRARY_FILE_CONTENT);
  const [initAcknowledged, setInitAcknowledged] = useState(false);
  const [librarySource, setLibrarySource] = useState<Dict | null>(null);
  const [rollbackPreview, setRollbackPreview] = useState<Dict | null>(null);
  const [rollbackAcknowledged, setRollbackAcknowledged] = useState(false);
  const [activeFile, setActiveFile] = useState<ChangeFile | null>(null);
  const [comparison, setComparison] = useState<Dict | null>(null);
  const [mergeSelectedFiles, setMergeSelectedFiles] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Dict | null>(null);
  const [files, setFiles] = useState<ChangeFile[]>([]);
  const [aiFiles, setAiFiles] = useState<Set<string>>(new Set());
  const [aiPrompt, setAiPromptValue] = useState("");
  const [resultPrompt, setResultPromptValue] = useState("");
  const [, setAiInstructionScope] = useState(() => createAiInstructionState({ flowId: "initial" }));
  const [aiProcessing, setAiProcessing] = useState(false);
  const [aiCancellable, setAiCancellable] = useState(false);
  const [aiCancelSettling, setAiCancelSettling] = useState(false);
  const [mergeNote, setMergeNoteValue] = useState("");
  const [confirmedFiles, setConfirmedFiles] = useState<Set<string>>(new Set());
  const [chatDraft, setChatDraftValue] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [busyState, setBusy] = useState("");
  const [saveTransaction, setSaveTransaction] = useState<Dict | null>(null);
  const busy = busyState || (aiCancelSettling ? "正在结束 AI 处理" : "");
  const [error, setError] = useState("");
  const [errorDetails, setErrorDetails] = useState("");
  const [analysisFailure, setAnalysisFailure] = useState<AnalysisFailure | null>(null);
  const [updateReviewStep, setUpdateReviewStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [confirmDirtyTakeover, setConfirmDirtyTakeover] = useState(false);
  const [takeoverStatusChecking, setTakeoverStatusChecking] = useState(false);
  const [takeoverStatus, setTakeoverStatus] = useState<TakeoverStatus>("unknown");
  const [scopeSelectionConfirmed, setScopeSelectionConfirmed] = useState(false);
  const pickerRequestRef = useRef(0);
  const aiInstructionScopeRef = useRef(createAiInstructionState({ flowId: "initial" }));
  const aiRequestGateRef = useRef(createAiComposerStateMachine({ flowId: "initial" }, createAiRequestGate));
  const chatRequestGateRef = useRef(createAiRequestGate({ flowId: "assistant" }));
  const aiComposerLockRef = useRef(false);
  // React's readOnly/disabled render is one frame behind a pointer event. This
  // synchronous lock closes that gap during AI dispatch and cancellation
  // settlement so a late input event cannot mutate the submitted scope.
  const aiInputLockRef = useRef(false);
  const busyRef = useRef("");
  const writeBusyRef = useRef(false);
  const editorIntentQueueRef = useRef(createEditorIntentQueue());
  const filesRef = useRef<ChangeFile[]>([]);
  const draftRef = useRef<Dict | null>(null);
  const confirmedFilesRef = useRef<Set<string>>(new Set());
  const editorSnapshotRef = useRef(new Map<string, { draftId: string; path: string; content: string; inputToken: number }>());
  const mergeReceiptRef = useRef<Dict | null>(null);
  const comparisonRef = useRef<Dict | null>(null);
  const flowRef = useRef<Flow>(flow);
  const cancellationBusyRef = useRef<any>(null);
  const chatCancellationBusyRef = useRef<any>(null);
  const screenRef = useRef<Screen>("home");

  const replaceConfirmedFiles = useCallback((fileIds: Iterable<string>) => {
    const next = new Set([...fileIds].map(String).filter(Boolean));
    confirmedFilesRef.current = next;
    setConfirmedFiles(next);
    return next;
  }, []);

  const rememberEditorSnapshot = useCallback((fileId: string, path: string, content: string, inputToken: number) => {
    editorSnapshotRef.current.set(fileId, {
      draftId: payloadId(draftRef.current),
      path,
      content,
      inputToken,
    });
  }, []);

  const currentEditorContent = useCallback((file: ChangeFile, inputToken: number) => {
    const snapshot = editorSnapshotRef.current.get(file.id);
    return snapshot
      && snapshot.inputToken === inputToken
      && snapshot.draftId === payloadId(draftRef.current)
      && snapshot.path === file.path
      ? snapshot.content
      : file.finalContent;
  }, []);

  const canMutateProductInputNow = useCallback(() => canMutateProductInput({
    aiActive: aiComposerLockRef.current || aiInputLockRef.current,
    busy: busyRef.current,
    requestLocked: aiRequestGateRef.current.isLocked() || chatRequestGateRef.current.isLocked(),
    writeLocked: writeBusyRef.current,
  }), []);

  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);

  useEffect(() => {
    comparisonRef.current = comparison;
  }, [comparison]);

  const canNavigateNow = useCallback((authorization: NavigationAuthorization = "user") => {
    const aiLocked = aiRequestGateRef.current.isLocked();
    const chatLocked = chatRequestGateRef.current.isLocked();
    const writeLocked = writeBusyRef.current;
    return canNavigateProduct({
      aiActive: aiLocked,
      busy: busyRef.current,
      requestLocked: chatLocked,
      writeLocked,
      authorization,
    });
  }, []);

  const navigate = useCallback((next: Screen, replace = false, authorization: NavigationAuthorization = "user", receipt: Dict | null = null) => {
    if (!canNavigateNow(authorization)) {
      setError("AI 处理进行中，请先取消或等待完成。");
      return false;
    }
    if (typeof window !== "undefined") {
      const href = pathFor(next, receipt);
      if (replace) window.history.replaceState({}, "", href);
      else window.history.pushState({}, "", href);
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    }
    screenRef.current = next;
    setScreen(next);
    setError("");
    setErrorDetails("");
    setAnalysisFailure(null);
    return true;
  }, [canNavigateNow]);

  // Capture the token for this render. Event handlers from an older render
  // must keep carrying that token even if they run after cancellation unlocks.
  const aiInputToken = aiRequestGateRef.current.inputToken();
  const chatInputToken = chatRequestGateRef.current.inputToken();

  const canEditChatInput = useCallback((inputToken = chatInputToken) => {
    if (inputToken !== chatRequestGateRef.current.inputToken()) return false;
    return canMutateProductInputNow() && !chatRequestGateRef.current.isLocked();
  }, [chatInputToken, canMutateProductInputNow]);

  const setChatDraftFromUser = useCallback((value: string, inputToken = chatInputToken) => {
    if (!canEditChatInput(inputToken)) return false;
    setChatDraftValue(value);
    return true;
  }, [canEditChatInput, chatInputToken]);

  const updateAiInstructionScope = useCallback((transform: (current: any) => any) => {
    const next = transform(aiInstructionScopeRef.current);
    aiInstructionScopeRef.current = next;
    setAiInstructionScope(next);
    return next;
  }, []);

  const setAiPrompt = useCallback((value: string, inputToken?: number) => {
    if (!canMutateProductInputNow() || !aiRequestGateRef.current.setPrompt("draft", value, inputToken)) return false;
    setAiPromptValue(value);
    updateAiInstructionScope((current) => ({ ...current, prompt: value }));
    return true;
  }, [canMutateProductInputNow, updateAiInstructionScope]);

  const setResultPrompt = useCallback((value: string, inputToken?: number) => {
    if (!canMutateProductInputNow() || !aiRequestGateRef.current.setPrompt("result", value, inputToken)) return false;
    setResultPromptValue(value);
    updateAiInstructionScope((current) => ({ ...current, resultPrompt: value }));
    return true;
  }, [canMutateProductInputNow, updateAiInstructionScope]);

  const cancelAiRequest = useCallback(async (request: any) => {
    if (!request) return true;
    const input = {
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.operationId ? { requestId: request.operationId } : {}),
    };
    if (!input.sessionId && !input.requestId) return true;
    await api.chatCancel(input);
    return true;
  }, []);

  const settleAiCancellation = useCallback(async (request: any, settlement: any) => {
    if (!request || !settlement) return false;
    const results = await Promise.allSettled([
      cancelAiRequest(request),
      waitForUiSettlementBoundary(),
    ]);
    const cancelResult = results[0];
    if (cancelResult.status === "rejected") {
      aiRequestGateRef.current.failCancelSettlement(settlement, errorTechnicalDetails(cancelResult.reason));
      if (cancellationBusyRef.current === settlement) {
        cancellationBusyRef.current = null;
        busyRef.current = "";
        setBusy("");
      }
      setAiCancelSettling(false);
      setAiProcessing(false);
      setAiCancellable(false);
      aiComposerLockRef.current = true;
      aiInputLockRef.current = true;
      setError("取消 AI 处理未完成，当前草稿已安全锁定。请切换到新的文件范围后重试。");
      setErrorDetails(errorTechnicalDetails(cancelResult.reason));
      return false;
    }
    if (aiRequestGateRef.current.settleCancel(settlement, { uiSettled: true, cancelRequestSettled: true })) {
      aiComposerLockRef.current = false;
      aiInputLockRef.current = false;
      if (cancellationBusyRef.current === settlement) {
        busyRef.current = "";
        setBusy("");
        cancellationBusyRef.current = null;
      }
      setAiCancelSettling(false);
      return true;
    }
    return false;
  }, [cancelAiRequest]);

  const resetAiForNewFlow = useCallback(async (flowId: string, draftId = "", fileIds: string[] = []) => {
    const reset = aiRequestGateRef.current.resetScope({ flowId, draftId, fileIds });
    if (!reset?.accepted) {
      if (reset?.settling) setError("AI 处理正在结束，请等待当前取消完成。");
      return false;
    }
    if (reset.pending && reset.request && reset.settlement) {
      aiComposerLockRef.current = true;
      aiInputLockRef.current = true;
      cancellationBusyRef.current = reset.settlement;
      setAiCancelSettling(true);
      const restored = aiRequestGateRef.current.restoreCancelledPrompt(reset.request);
      if (!restored || !aiRequestGateRef.current.markCancelRestoreCommitted(reset.settlement)) {
        aiRequestGateRef.current.failCancelSettlement(reset.settlement, "取消前的 prompt 恢复未完成");
        if (cancellationBusyRef.current === reset.settlement) cancellationBusyRef.current = null;
        setAiCancelSettling(false);
        setAiProcessing(false);
        setAiCancellable(false);
        if (!writeBusyRef.current) {
          busyRef.current = "";
          setBusy("");
        }
        aiComposerLockRef.current = true;
        aiInputLockRef.current = true;
        setError("取消 AI 处理未完成，当前草稿已安全锁定。请切换到新的文件范围后重试。");
        return false;
      }
      setAiProcessing(false);
      setAiCancellable(false);
      if (!await settleAiCancellation(reset.request, reset.settlement)) return false;
    }
    const nextScope = aiRequestGateRef.current.currentScope();
    const nextPrompt = aiRequestGateRef.current.currentPromptState();
    updateAiInstructionScope((current) => ({
      ...transitionAiInstructionScope(current, nextScope),
      prompt: nextPrompt.aiPrompt,
      resultPrompt: nextPrompt.resultPrompt,
    }));
    setAiPromptValue(nextPrompt.aiPrompt);
    setResultPromptValue(nextPrompt.resultPrompt);
    const editableIds = new Set(aiEditableFileIds(filesRef.current));
    setAiFiles(new Set(nextScope.fileIds.filter((fileId) => editableIds.has(String(fileId)))));
    replaceConfirmedFiles([]);
    setAiProcessing(false);
    setAiCancellable(false);
    if (!aiRequestGateRef.current.isLocked()) {
      aiComposerLockRef.current = false;
      aiInputLockRef.current = false;
      setAiCancelSettling(false);
    }
    setError("");
    setErrorDetails("");
    return true;
  }, [replaceConfirmedFiles, settleAiCancellation, updateAiInstructionScope]);

  const setScopedAiFiles = useCallback((fileIds: Iterable<string>, inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    const editableIds = new Set(aiEditableFileIds(filesRef.current));
    const ids = [...new Set([...fileIds].map(String).filter((fileId) => editableIds.has(fileId)))];
    const scope = aiRequestGateRef.current.currentScope();
    const previous = aiRequestGateRef.current.setScope({ ...scope, fileIds: ids });
    if (previous === false) return false;
    if (previous) void cancelAiRequest(previous).catch(() => {});
    if (!aiRequestGateRef.current.clearPromptState()) return false;
    updateAiInstructionScope((current) => ({
      ...resetAiFileSelection(current, ids),
      prompt: "",
      resultPrompt: "",
    }));
    setAiPromptValue("");
    setResultPromptValue("");
    setAiFiles(new Set(ids));
    return true;
  }, [aiInputToken, canMutateProductInputNow, cancelAiRequest, updateAiInstructionScope]);

  const clearAiInstructionText = useCallback(() => {
    if (!canMutateProductInputNow() || !aiRequestGateRef.current.clearPromptState()) return false;
    updateAiInstructionScope((current) => ({ ...current, prompt: "", resultPrompt: "" }));
    setAiPromptValue("");
    setResultPromptValue("");
    return true;
  }, [canMutateProductInputNow, updateAiInstructionScope]);

  const setMergeSelection = useCallback((filePaths: Iterable<string>, inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    const next = new Set([...filePaths].map(String).filter(Boolean));
    if (!clearAiInstructionText()) return false;
    setMergeSelectedFiles(next);
    return true;
  }, [aiInputToken, canMutateProductInputNow, clearAiInstructionText]);

  const setMergeNote = useCallback((value: string, inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    setMergeNoteValue(value);
    return true;
  }, [aiInputToken, canMutateProductInputNow]);

  const resetNewDraftForm = useCallback(() => {
    const next = completeLibraryDraft({ open: newDraftOpen, path: newFilePath, content: newFileContent }, "library-manual-edit");
    setNewDraftOpen(next.open);
    setNewFilePath(next.path);
    setNewFileContent(next.content);
  }, [newDraftOpen, newFileContent, newFilePath]);

  const refreshOverview = useCallback(async (receiptQuery: ProductReceiptQuery = {}) => {
    const requestedReceipt = hasProductReceiptQuery(receiptQuery);
    const persistedReceipt = readPersistedProductReceipt();
    if (requestedReceipt) {
      // A refresh from an old result URL must not briefly fall back to an
      // empty in-memory overview. Keep a matching browser receipt as a
      // temporary placeholder until the server returns its authoritative
      // sidecar; never use a receipt for a different result.
      mergeReceiptRef.current = receiptMatchesQuery(persistedReceipt, receiptQuery) ? persistedReceipt : null;
    } else mergeReceiptRef.current = retainAuthoritativeReceipt(mergeReceiptRef.current, persistedReceipt);
    let value = await api.overview(receiptQuery);
    const mapped = normalizeOverview(value);
    const connected = array(mapped.worktrees).map(workspaceFrom).filter((tree) => tree.path && tree.planId);
    if (connected.length) {
      await Promise.all(connected.map((tree) => api.workspaceCheck({ workspacePath: tree.path, worktreePath: tree.path }).catch(() => null)));
      value = await api.overview(receiptQuery);
    }
    const normalized = normalizeOverview(value);
    const receipt = [
      normalized.productReceipt,
      normalized.mergeReceipt,
      normalized.commitReceipt,
      dict(normalized.version).productReceipt,
      dict(normalized.version).mergeReceipt,
      dict(normalized.version).commitReceipt,
      dict(normalized.draft).productReceipt,
      dict(normalized.draft).mergeReceipt,
      dict(normalized.draft).commitReceipt,
    ].map((candidate) => authoritativeProductReceipt(candidate)).find(Boolean) || null;
    const selectedReceipt = requestedReceipt && !receiptMatchesQuery(receipt, receiptQuery) ? null : receipt;
    mergeReceiptRef.current = retainAuthoritativeReceipt(mergeReceiptRef.current, selectedReceipt);
    const hydrated = {
      ...normalized,
      productReceipt: mergeReceiptRef.current,
      mergeReceipt: stringValue(mergeReceiptRef.current?.status).toLowerCase() === "merged" ? mergeReceiptRef.current : null,
      commitReceipt: stringValue(mergeReceiptRef.current?.status).toLowerCase() === "committed" ? mergeReceiptRef.current : null,
    };
    setOverview(hydrated);
    return hydrated;
  }, []);

  const refreshLibrary = useCallback(async (receiptQuery: ProductReceiptQuery = {}) => {
    const requestedReceipt = hasProductReceiptQuery(receiptQuery);
    const value = await api.library(receiptQuery);
    const raw = dict(value);
    const receipt = [
      raw.productReceipt,
      raw.mergeReceipt,
      raw.commitReceipt,
      ...array(raw.commitReceipts),
      dict(raw.version).productReceipt,
      dict(raw.version).mergeReceipt,
      dict(raw.version).commitReceipt,
      dict(raw.draft).productReceipt,
      dict(raw.draft).mergeReceipt,
      dict(raw.draft).commitReceipt,
    ].map((candidate) => authoritativeProductReceipt(candidate)).find(Boolean) || null;
    const selectedReceipt = requestedReceipt && !receiptMatchesQuery(receipt, receiptQuery) ? null : receipt;
    if (requestedReceipt) mergeReceiptRef.current = retainAuthoritativeReceipt(mergeReceiptRef.current, selectedReceipt);
    else if (selectedReceipt) mergeReceiptRef.current = retainAuthoritativeReceipt(mergeReceiptRef.current, selectedReceipt);
    if (selectedReceipt) {
      persistProductReceipt(mergeReceiptRef.current);
      setOverview((current) => current ? {
        ...current,
        productReceipt: mergeReceiptRef.current,
        mergeReceipt: stringValue(mergeReceiptRef.current?.status).toLowerCase() === "merged" ? mergeReceiptRef.current : null,
        commitReceipt: stringValue(mergeReceiptRef.current?.status).toLowerCase() === "committed" ? mergeReceiptRef.current : null,
      } : current);
    }
    setLibrary({
      ...raw,
      ...(mergeReceiptRef.current ? {
        productReceipt: mergeReceiptRef.current,
        ...(stringValue(mergeReceiptRef.current.status).toLowerCase() === "merged" ? { mergeReceipt: mergeReceiptRef.current } : {}),
        ...(stringValue(mergeReceiptRef.current.status).toLowerCase() === "committed" ? { commitReceipt: mergeReceiptRef.current } : {}),
      } : {}),
    });
    return value;
  }, []);

  const safeAction = useCallback(async (
    label: string,
    action: () => Promise<void>,
    onError?: (formatted: { message: string; technical: string; code: string }) => void,
    canApply: () => boolean = () => true,
  ) => {
    busyRef.current = label;
    setBusy(label);
    setError("");
    setErrorDetails("");
    try {
      await action();
    } catch (caught) {
      if (!canApply()) return;
      const formatted = formatProductError(caught);
      setError(formatted.message);
      setErrorDetails(formatted.technical);
      onError?.(formatted);
    } finally {
      if (canApply()) {
        busyRef.current = "";
        setBusy("");
      }
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const receiptQuery = productReceiptQuery(window.location.search);
        const value = await refreshOverview(receiptQuery);
        if (!alive) return;
        let mapped = normalizeOverview(value);
        if (mapped.initialized) {
          // Hydrate the version-local receipt before resolving terminal routes.
          // This keeps old URLs and browser back/forward from rendering a
          // transient zero-file success page while overview catches up.
          await refreshLibrary(receiptQuery).catch(() => null);
          mapped = normalizeOverview({ ...mapped, productReceipt: mergeReceiptRef.current || mapped.productReceipt });
        }
        const resolvedRoute = resolveProductRoute(window.location.pathname, {
          mergeReceipt: mergeReceiptRef.current || mapped.mergeReceipt,
          commitReceipt: mapped.commitReceipt,
          productReceipt: mapped.productReceipt,
        });
        const route = resolvedRoute.screen as Screen;
        mergeReceiptRef.current = retainAuthoritativeReceipt(mergeReceiptRef.current, resolvedRoute.receipt);
        const requestedRoute = screenForPath(window.location.pathname);
        if (requestedRoute !== route && ["merge", "merge-success", "update-result", "update-success"].includes(requestedRoute)) {
          window.history.replaceState({}, "", pathFor(route, resolvedRoute.receipt));
        }
        screenRef.current = route;
        let skippedInitialization = false;
        try {
          skippedInitialization = window.sessionStorage.getItem(SKIP_INITIALIZATION_KEY) === "1";
        } catch {
          // Session storage is only a convenience for this browser session.
        }
        if (window.location.pathname === "/" && !mapped.initialized && !skippedInitialization) {
          screenRef.current = "welcome";
          setScreen("welcome");
        } else setScreen(route);
      } catch (caught) {
        if (alive) {
          const formatted = formatProductError(caught);
          setError(formatted.message);
          setErrorDetails(formatted.technical);
          setScreen("recovery");
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const onPopState = () => {
      if (!canNavigateNow("user")) {
        window.history.replaceState({}, "", pathFor(screenRef.current, mergeReceiptRef.current));
        setError("AI 处理进行中，请先取消或等待完成。");
        return;
      }
      const receiptQuery = productReceiptQuery(window.location.search);
      if (hasProductReceiptQuery(receiptQuery)) {
        void refreshOverview(receiptQuery).then(async (value) => {
          if (!alive || !canNavigateNow("user")) return;
          await refreshLibrary(receiptQuery).catch(() => null);
          if (!alive || !canNavigateNow("user")) return;
          const mapped = normalizeOverview({ ...value, productReceipt: mergeReceiptRef.current || normalizeOverview(value).productReceipt });
          const resolvedRoute = resolveProductRoute(window.location.pathname, {
            mergeReceipt: mergeReceiptRef.current || mapped.mergeReceipt,
            commitReceipt: mapped.commitReceipt,
            productReceipt: mapped.productReceipt,
          });
          const next = resolvedRoute.screen as Screen;
          const requestedRoute = screenForPath(window.location.pathname);
          mergeReceiptRef.current = retainAuthoritativeReceipt(mergeReceiptRef.current, resolvedRoute.receipt);
          if (requestedRoute !== next && ["merge", "merge-success", "update-result", "update-success"].includes(requestedRoute)) {
            window.history.replaceState({}, "", pathFor(next, resolvedRoute.receipt));
          }
          screenRef.current = next;
          setScreen(next);
        }).catch((caught: unknown) => {
          if (!alive) return;
          const formatted = formatProductError(caught);
          setError(formatted.message);
          setErrorDetails(formatted.technical);
        });
        return;
      }
      const resolvedRoute = resolveProductRoute(window.location.pathname, {
        mergeReceipt: mergeReceiptRef.current,
        activeConnection: flowRef.current === "connect",
      });
      const next = resolvedRoute.screen as Screen;
      const requestedRoute = screenForPath(window.location.pathname);
      if (requestedRoute !== next && ["merge", "merge-success", "update-result", "update-success"].includes(requestedRoute)) {
        window.history.replaceState({}, "", pathFor(next, resolvedRoute.receipt));
      }
      screenRef.current = next;
      setScreen(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      alive = false;
      window.removeEventListener("popstate", onPopState);
    };
  }, [canNavigateNow, refreshLibrary, refreshOverview]);

  useEffect(() => {
    if (screen !== "library") return;
    let alive = true;
    void refreshLibrary().catch((caught: unknown) => {
      if (alive) {
        const formatted = formatProductError(caught);
        setError(formatted.message);
        setErrorDetails(formatted.technical);
      }
    });
    return () => { alive = false; };
  }, [refreshLibrary, screen]);

  useEffect(() => {
    if (screen !== "takeover-success") {
      setTakeoverStatusChecking(false);
      setTakeoverStatus("unknown");
      return;
    }
    let alive = true;
    const expectedPath = stablePathKey(workspace?.path);
    setTakeoverStatus("checking");
    setTakeoverStatusChecking(true);
    void refreshOverview().then((value) => {
      if (!alive) return;
      const mapped = normalizeOverview(value);
      const authoritative = authoritativeTakeoverWorkspace(mapped.worktrees, expectedPath);
      if (!authoritative) {
        setWorkspace(null);
        setComparison(null);
        setTakeoverStatus("unknown");
        setError("无法确认这次接管对应的工作区，已禁用回滚。请返回首页。");
        setErrorDetails("");
        return;
      }
      setWorkspace(authoritative);
      if (authoritative.connectionMode !== "takeover" || !authoritative.protectionId) {
        setTakeoverStatus("rolled-back");
        setComparison((current) => ({ ...(current || {}), status: "rolled-back", protectionStatus: "rolled-back", protectionId: "" }));
        window.history.replaceState({}, "", pathFor("home"));
        screenRef.current = "home";
        setScreen("home");
        setError("这次接管已经回滚，旧的接管成功页已关闭。");
        setErrorDetails("");
      } else {
        setTakeoverStatus("active");
        setComparison((current) => current ? { ...current, protectionId: authoritative.protectionId } : current);
        setError("");
        setErrorDetails("");
      }
    }).catch((caught: unknown) => {
      if (!alive) return;
      setTakeoverStatus("unknown");
      setWorkspace((current) => current ? { ...current, connectionMode: "", protectionId: "" } : current);
      setComparison(null);
      const formatted = formatProductError(caught);
      setError("无法核对这次接管的当前状态，已禁用回滚。请返回首页后重试。");
      setErrorDetails(formatted.technical);
    }).finally(() => {
      if (alive) setTakeoverStatusChecking(false);
    });
    return () => { alive = false; };
  }, [refreshOverview, screen, workspace?.path]);

  useEffect(() => {
    const query = globalSearch.trim();
    if (!query) {
      setGlobalSearchResults([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void api.search(query).then((value: unknown) => {
        if (alive) setGlobalSearchResults(array(dict(value).results).map(dict));
      }).catch(() => {
        if (alive) setGlobalSearchResults([]);
      });
    }, 160);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [globalSearch]);

  const overviewChanges = useMemo(() => array(overview?.changes), [overview]);
  const worktrees = useMemo(() => array(overview?.worktrees).map(workspaceFrom), [overview]);
  const librarySystems = useMemo(() => normalizeSystems(library || {}), [library]);
  const libraryFiles = useMemo(() => normalizeFiles(library || {}), [library]);
  const history = useMemo(() => array(first(library?.history, library?.versions, library?.versionHistory, library?.plan?.versions)), [library]);
  const changedSkills = useMemo(() => summarizeChangedSkills(files.filter((file) => file.direction !== "center-only")), [files]);
  const blockedAnalysisSystems = useMemo(() => {
    const declared = array(analysis?.safety?.blockedSystems).map(dict);
    if (declared.length) return declared;
    return systems.filter((item) => item.blocked).map((item) => ({
      id: item.id,
      name: item.name,
      reason: item.unavailableReason,
      safeReason: item.safeReason,
      diagnosticPaths: item.diagnosticPaths,
    }));
  }, [analysis, systems]);
  const selectionReviewPending = Boolean(workspace?.selectionNeedsReview) && !scopeSelectionConfirmed;
  const filteredSystems = useMemo(() => {
    const query = librarySearch.trim().toLowerCase();
    if (!query) return librarySystems;
    return librarySystems.filter((item) => `${item.name} ${item.subtitle} ${item.id}`.toLowerCase().includes(query));
  }, [librarySearch, librarySystems]);
  const filteredLibraryFiles = useMemo(() => {
    const query = librarySearch.trim().toLowerCase();
    if (!query) return libraryFiles;
    const matchingSystemPaths = new Set(filteredSystems.flatMap((item) => item.filePaths || []));
    return libraryFiles.filter((file) => matchingSystemPaths.has(file.path) || `${file.path} ${file.skill} ${file.status}`.toLowerCase().includes(query));
  }, [filteredSystems, libraryFiles, librarySearch]);
  const activePlan = array(overview?.plans).map(dict).find((plan) => stringValue(plan.planId, plan.id) === stringValue(overview?.activePlanId)) || dict(overview?.plan);
  const activePlanId = stringValue(overview?.activePlanId, overview?.planId, overview?.library?.planId, activePlan.planId, analysis?.planId, analysis?.projectPlanId);
  const activeVersion = stringValue(overview?.currentVersion, overview?.library?.currentVersion, overview?.version, activePlan.currentVersion, "v1");
  const aiCancelVisible = shouldShowAiCancel({ aiProcessing, aiCancellable });
  const aiComposerLocked = aiInputLockRef.current || aiCancelSettling || isAiComposerLocked({
    aiProcessing,
    busy,
    requestLocked: aiRequestGateRef.current.isLocked() || chatRequestGateRef.current.isLocked(),
    writeLocked: writeBusyRef.current,
  });
  aiComposerLockRef.current = aiComposerLocked;
  busyRef.current = busy;
  filesRef.current = files;
  draftRef.current = draft;
  confirmedFilesRef.current = confirmedFiles;
  const completeUpdateCheck = useCallback(async () => {
    if (screen !== "update-review" || updateReviewStep <= 1 || filesRef.current.length || blockedAnalysisSystems.length || selectionReviewPending) return false;
    let completed = false;
    await safeAction("正在确认工作区已同步", async () => {
      await refreshOverview();
      completed = true;
    });
    return completed ? navigate("home", true) : false;
  }, [blockedAnalysisSystems.length, navigate, refreshOverview, safeAction, screen, selectionReviewPending, updateReviewStep]);
  const workspaceRecheck = workspaceRecheckPresentation({
    phase: busy === WORKSPACE_RECHECK_BUSY_LABEL ? "pending" : "idle",
    hasChanges: overviewChanges.length,
  });

  const renderSafetyEvidence = (items: Dict[], heading: string) => items.length ? <section className="system-blocked safety-evidence" role="alert" data-testid="safety-evidence"><strong>{heading}</strong><p>{stringValue(items[0].reason, items[0].unavailableReason, "检测到指向所选工作区外部的 Junction / 链接，已停止读取。")}</p><p>{stringValue(items[0].safeReason, "请将链接目标移入所选工作区，或改用工作区内的规范目录后重新分析。")}</p>{items.flatMap((item) => array(item.diagnosticPaths).map(String)).length ? <details className="tech-details"><summary>查看技术诊断</summary><pre>{items.flatMap((item) => array(item.diagnosticPaths).map(String)).join("\n")}</pre></details> : null}</section> : null;

  const renderSelectionReview = () => workspace?.selectionNeedsReview ? <section className="scope-review-banner card" role="alert" data-testid="selection-review"><strong>原有连接范围需要确认</strong><p>{workspace.selectionReviewMessage || "原有项目体系无法唯一匹配。只读分析不会自动扩大范围，请勾选要继续连接的体系。"}</p><small>{scopeSelectionConfirmed ? "当前勾选将作为明确的新范围。" : "请确认下方勾选后再继续。"}</small></section> : null;

  const openLibraryFile = useCallback(async (file: ChangeFile) => {
    setActiveFile(file);
    if (!activePlanId) return;
    await safeAction("正在读取文件", async () => {
      const value = await api.libraryFile({ planId: activePlanId, version: activeVersion, path: file.path });
      const raw = dict(value);
      if (raw.content === undefined) throw new Error("中心库没有返回文件正文。");
      setActiveFile({ ...file, finalContent: String(raw.content), originalContent: String(raw.content), contentLoaded: true });
    });
  }, [activePlanId, activeVersion, safeAction]);

  useEffect(() => {
    if (screen !== "library") return;
    const candidate = preferredLibraryFile(activeFile, filteredLibraryFiles);
    if (!candidate) {
      if (activeFile) setActiveFile(null);
      return;
    }
    if (activeFile?.path !== candidate.path || !activeFile?.contentLoaded) void openLibraryFile(candidate);
  }, [activeFile, filteredLibraryFiles, openLibraryFile, screen]);

  useEffect(() => {
    const draftId = payloadId(draftRef.current || draft);
    const sourceFiles = filesRef.current.length ? filesRef.current : files;
    if (screen !== "update-result" || !draftId || !sourceFiles.length) return;
    let cancelled = false;
    const loadDraftFiles = async () => {
      try {
        const draftValue = dict(await api.draft(draftId));
        if (!cancelled) {
          const currentFiles = filesRef.current.length ? filesRef.current : sourceFiles;
          const localConfirmedPaths = new Set(currentFiles
            .filter((file) => confirmedFilesRef.current.has(file.id))
            .map((file) => file.path));
          const records = normalizeFiles(draftValue).map((record) => (
            localConfirmedPaths.has(record.path) && record.confirmed === false
              ? { ...record, confirmed: true }
              : record
          ));
          const rawFiles = array(draftValue.files);
          const authoritativeDraft = rawFiles.length
            ? {
              ...draftValue,
              files: rawFiles.map((item) => {
                const row = dict(item);
                const itemPath = stringValue(row.path, row.file, row.name);
                return localConfirmedPaths.has(itemPath) && row.confirmed === false
                  ? { ...row, confirmed: true }
                  : row;
              }),
            }
            : draftValue;
          draftRef.current = authoritativeDraft;
          setDraft(authoritativeDraft);
          if (records.length) {
            const merged = mergeDraftFiles(currentFiles, records);
            filesRef.current = merged;
            setFiles(merged);
          }
        }
      } catch {
        // A draft can still be displayed from the comparison response while
        // the server is catching up; the per-file reads below remain useful.
      }
      const loaded = await Promise.all(sourceFiles.map(async (file) => {
        try {
          const value = dict(await api.libraryFile({ draftId, path: file.path }));
          return value.content === undefined ? null : { path: file.path, content: String(value.content) };
        } catch {
          return null;
        }
      }));
      if (cancelled) return;
      const nextFiles = (filesRef.current.length ? filesRef.current : sourceFiles).map((file) => {
        const value = loaded.find((item) => item?.path === file.path);
        return value ? { ...file, finalContent: value.content } : file;
      });
      filesRef.current = nextFiles;
      setFiles(nextFiles);
    };
    void loadDraftFiles();
    return () => { cancelled = true; };
  }, [files.length, payloadId(draft), screen]);

  const chooseWorkspace = useCallback(async (purpose: "initialize" | "connect") => {
    const requestId = pickerRequestRef.current + 1;
    pickerRequestRef.current = requestId;
    setBusy("正在打开资源管理器");
    setError("");
    try {
      const value = await api.pickFolder({ purpose });
      if (requestId !== pickerRequestRef.current) return;
      const raw = dict(value);
      if (raw.cancelled || raw.canceled) return;
      const picked = workspaceFrom(value);
      if (!picked.path) throw new Error("没有收到所选工作区路径，当前没有任何写入。");
      setWorkspace(picked);
    } catch (caught) {
      if (requestId === pickerRequestRef.current) {
        const formatted = formatProductError(caught);
        setError(formatted.message);
        setErrorDetails(formatted.technical);
      }
    } finally {
      if (requestId === pickerRequestRef.current) setBusy("");
    }
  }, []);

  const applyManualWorkspacePath = useCallback(() => {
    const accepted = acceptManualWorkspacePath(manualWorkspacePath, pickerRequestRef.current);
    if (!accepted.accepted) return setError(accepted.error);
    // A manual path is a new authoritative selection. Any late native picker
    // response is ignored and cannot replace it or clear a newer busy state.
    pickerRequestRef.current = accepted.requestId;
    setBusy("");
    setManualPathOpen(false);
    setWorkspace(workspaceFrom(accepted.path));
    setError("");
  }, [manualWorkspacePath]);

  const analyzeWorkspace = useCallback(async (mode: Flow, targetWorkspace?: Workspace) => {
    const target = targetWorkspace || workspace;
    if (!target?.path) {
      setError("请先选择一个工作区。");
      return;
    }
    setWorkspace(target);
    setManualWorkspacePath(target.path);
    setFlow(mode);
    setAnalysisFailure(null);
    setAnalysis(null);
    setSystems([]);
    editorSnapshotRef.current.clear();
    setFiles([]);
    setComparison(null);
    setDraft(null);
    setUpdateReviewStep(1);
    setMergeNoteValue("");
    replaceConfirmedFiles([]);
    setScopeSelectionConfirmed(false);
    if (!await resetAiForNewFlow(`${mode}:${target.path}`)) return;
    if (mode === "initialize") setInitAcknowledged(false);
    navigate("analysis");
    await safeAction("正在只读分析", async () => {
      const value = await api.analyze({ workspacePath: target.path, path: target.path, mode, purpose: mode });
      const raw = dict(value);
      setAnalysis(raw);
      const nextSystems = normalizeSystems(value);
      setSystems(nextSystems);
      const recommended = nextSystems.filter((item) => item.decision !== "reference-only" && item.decision !== "keep-private").map((item) => item.id);
      const returnedWorkspace = workspaceFrom(raw.workspace);
      const analyzedTarget = returnedWorkspace.path ? { ...target, ...returnedWorkspace } : target;
      const persistedScope = hasPersistedSystemScope(analyzedTarget);
      const connectedReanalysis = mode !== "initialize" && Boolean(
        analyzedTarget.planId
          || analyzedTarget.connectionMode
          || analyzedTarget.baselineVersion
          || mode === "update",
      );
      const restoredIds = connectedReanalysis && persistedScope ? preservedSystemIds(analyzedTarget, nextSystems) : [];
      const expectedScopeCount = Math.max(
        array(analyzedTarget.selectedSystemIds).length,
        array(analyzedTarget.selectedSystemRefs).length,
        array(analyzedTarget.unresolvedSelectedSystemRefs).length,
      );
      const selectionNeedsReview = connectedReanalysis && (
        !persistedScope
        || Boolean(analyzedTarget.selectionNeedsReview)
        || restoredIds.length < expectedScopeCount
      );
      const scopedTarget = { ...analyzedTarget, selectionNeedsReview };
      setWorkspace(scopedTarget);
      const chosen = connectedReanalysis
        ? restoredIds
        : recommended.length
          ? (mode === "initialize" ? recommended.slice(0, 1) : recommended)
          : nextSystems.slice(0, mode === "initialize" ? 1 : nextSystems.length).map((item) => item.id);
      setSelectedSystems(new Set(chosen));
      if (mode === "update") {
        if (Boolean(raw.safety?.blocked) || numberValue(raw.summary?.externalLinks) > 0 || selectionNeedsReview) {
          comparisonRef.current = raw;
          setComparison(raw);
          setAiFiles(new Set());
          setUpdateReviewStep(2);
          busyRef.current = "";
          setBusy("");
          navigate("update-review");
          return;
        }
        if (!activePlanId) throw new Error("中心库尚未返回项目方案编号，无法比较更新。");
        const compared = dict(await api.compare({
          workspacePath: scopedTarget.path,
          path: scopedTarget.path,
          mode,
          analysisId: stringValue(raw.id, raw.analysisId),
          selectedSystems: chosen,
          selectionConfirmed: false,
          includePrivate: chosen.some((id) => nextSystems.find((item) => item.id === id)?.decision === "keep-private"),
          planId: activePlanId,
        }));
        const nextFiles = normalizeFiles(compared).filter((item) => item.direction !== "center-only");
        comparisonRef.current = compared;
        setComparison(compared);
        filesRef.current = nextFiles;
        setFiles(nextFiles);
        setAiFiles(new Set(aiEditableFileIds(nextFiles)));
        setMergeSelectedFiles(new Set(nextFiles.filter((item) => item.direction !== "center-only").map((item) => item.path)));
        setUpdateReviewStep(2);
        busyRef.current = "";
        setBusy("");
        if (!nextFiles.length) await refreshOverview();
        navigate("update-review");
      }
    }, (formatted) => {
      // Analysis errors are a terminal state for this screen.  Keep the
      // recovery controls in the flow instead of leaving a stale scan/progress
      // presentation underneath a toast.
      setAnalysisFailure({ message: formatted.message, technical: formatted.technical });
    });
  }, [activePlanId, navigate, refreshOverview, replaceConfirmedFiles, resetAiForNewFlow, safeAction, workspace]);

  const openWorkspaceUpdate = useCallback((target: Workspace) => {
    void analyzeWorkspace("update", target);
  }, [analyzeWorkspace]);

  const checkConnectedWorkspace = useCallback(async () => {
    const target = workspace?.path || worktrees[0]?.path;
    if (!target) {
      await safeAction(WORKSPACE_RECHECK_BUSY_LABEL, async () => {
        await refreshOverview();
      });
      return;
    }
    await safeAction(WORKSPACE_RECHECK_BUSY_LABEL, async () => {
      await api.workspaceCheck({ worktreePath: target, workspacePath: target, path: target });
      await refreshOverview();
    });
  }, [refreshOverview, safeAction, workspace?.path, worktrees]);

  const initializeLibrary = useCallback(async (inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    if (!workspace?.path) return setError("没有可初始化的工作区。");
    if (!initAcknowledged) return setError("请先勾选已查看纳入范围和保全边界。");
    writeBusyRef.current = true;
    try {
      await safeAction("正在创建中心库 v1", async () => {
        const value = await api.initializeLibrary({ workspacePath: workspace.path, path: workspace.path, analysisId: stringValue(analysis?.id, analysis?.analysisId), selectedSystems: [...selectedSystems], systemIds: [...selectedSystems], planId: stringValue(analysis?.planId, analysis?.projectPlanId), acknowledgeProtection: true });
        setLibrary(dict(value));
        try {
          window.sessionStorage.removeItem(SKIP_INITIALIZATION_KEY);
        } catch {
          // Initialization succeeded even when the browser blocks session storage.
        }
        await refreshOverview();
        writeBusyRef.current = false;
        busyRef.current = "";
        setBusy("");
        navigate("init-success", true);
      });
    } finally {
      writeBusyRef.current = false;
    }
  }, [aiInputToken, analysis, canMutateProductInputNow, initAcknowledged, navigate, refreshOverview, safeAction, selectedSystems, workspace]);

  const compareWorkspace = useCallback(async (mode: "merge" | "update") => {
    if (!workspace?.path) return setError("没有可比较的工作区。");
    await safeAction("正在比较文件差异", async () => {
      if (!activePlanId) throw new Error("中心库尚未返回项目方案编号，无法比较。");
      // Home/workspace shortcuts can enter the update flow before an analysis
      // object exists in this browser session.  Analyze first (still read-only)
      // so compare always receives the backend's analysisId and selected
      // systems instead of producing a misleading empty result.
      let activeAnalysis = analysis;
      let activeSelectedSystems = [...selectedSystems];
      if (!activeAnalysis?.analysisId && !activeAnalysis?.id) {
        const analyzed = await api.analyze({ workspacePath: workspace.path, path: workspace.path, mode, purpose: mode });
        activeAnalysis = dict(analyzed);
        setAnalysis(activeAnalysis);
        const nextSystems = normalizeSystems(analyzed);
        setSystems(nextSystems);
        const returnedWorkspace = workspaceFrom(dict(analyzed).workspace);
        const activeWorkspace = returnedWorkspace.path ? { ...workspace, ...returnedWorkspace } : workspace;
        setWorkspace(activeWorkspace);
        const recommended = nextSystems
          .filter((item) => item.decision !== "reference-only" && item.decision !== "keep-private")
          .map((item) => item.id);
        const persistedScope = hasPersistedSystemScope(activeWorkspace);
        const connectedIds = persistedScope ? preservedSystemIds(activeWorkspace, nextSystems) : [];
        activeSelectedSystems = persistedScope
          ? connectedIds
          : (recommended.length ? recommended.slice(0, 1) : nextSystems.slice(0, 1).map((item) => item.id));
        setSelectedSystems(new Set(activeSelectedSystems));
        if (Boolean(dict(analyzed).safety?.blocked)) {
          comparisonRef.current = activeAnalysis;
          setComparison(activeAnalysis);
          filesRef.current = [];
          setFiles([]);
          busyRef.current = "";
          setBusy("");
          navigate("update-review");
          return;
        }
      }
      const value = await api.compare({ workspacePath: workspace.path, path: workspace.path, mode, analysisId: stringValue(activeAnalysis?.id, activeAnalysis?.analysisId), selectedSystems: activeSelectedSystems, selectionConfirmed: mode === "merge" && flow === "connect" && scopeSelectionConfirmed, includePrivate: activeSelectedSystems.some((id) => systems.find((item) => item.id === id)?.decision === "keep-private"), planId: activePlanId });
      const raw = dict(value);
      const comparedFiles = normalizeFiles(value);
      const hasWorkspaceChanges = comparedFiles.some((item) => item.direction !== "center-only");
      const nextFiles = mode === "merge" && !hasWorkspaceChanges
        ? []
        : comparedFiles.filter((item) => mode === "merge" || item.direction !== "center-only");
      comparisonRef.current = raw;
      setComparison(raw);
      filesRef.current = nextFiles;
      setFiles(nextFiles);
      setAiFiles(new Set(aiEditableFileIds(nextFiles)));
      setMergeSelectedFiles(new Set(nextFiles.filter((item) => item.direction !== "center-only").map((item) => item.path)));
      const returnedDraft = dict(first(raw.draft, raw.result));
      if (Object.keys(returnedDraft).length) {
        draftRef.current = returnedDraft;
        setDraft(returnedDraft);
      }
      busyRef.current = "";
      setBusy("");
      navigate(mode === "update" ? "update-compare" : "merge");
    });
  }, [activePlanId, analysis, flow, navigate, safeAction, scopeSelectionConfirmed, selectedSystems, systems, workspace]);

  const completeConnection = useCallback(async (inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    if (!workspace?.path) return setError("没有可完成连接的工作区。");
    writeBusyRef.current = true;
    try {
      if (!await resetAiForNewFlow(`complete-connection:${workspace.path}`)) return false;
      writeBusyRef.current = false;
      await safeAction("正在完成连接", async () => {
        const value = dict(await api.completeConnection({
          workspacePath: workspace.path,
          worktreePath: workspace.path,
          planId: activePlanId,
          analysisId: stringValue(analysis?.id, analysis?.analysisId, workspace.lastAnalysisId),
          selectedSystems: [...selectedSystems],
          selectedSystemIds: [...selectedSystems],
          selectedSystemRefs: array(workspace.selectedSystemRefs).map(dict),
          selectionConfirmed: scopeSelectionConfirmed,
          confirmSelection: scopeSelectionConfirmed,
        }));
        const connected = workspaceFrom(value.workspace);
        if (connected.path) setWorkspace(connected);
        setScopeSelectionConfirmed(false);
        await refreshOverview();
        writeBusyRef.current = false;
        busyRef.current = "";
        setBusy("");
        navigate("home", true);
      });
    } finally {
      writeBusyRef.current = false;
    }
  }, [activePlanId, aiInputToken, analysis, canMutateProductInputNow, navigate, refreshOverview, resetAiForNewFlow, safeAction, selectedSystems, workspace]);

  const createMergeDraft = useCallback(async (inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    if (!workspace?.path) return setError("没有可融合的工作区。");
    // resetAiForNewFlow is async even for an idle composer. Hold the
    // synchronous write gate across that boundary so a same-tick second
    // merge entry cannot queue a second draft before safeAction starts.
    writeBusyRef.current = true;
    try {
      if (!await resetAiForNewFlow(`merge:${workspace.path}`)) return false;
      writeBusyRef.current = false;
      await safeAction("正在生成融合草稿", async () => {
        const value = await api.libraryDraft({ comparisonId: stringValue(comparison?.id, comparison?.comparisonId), planId: activePlanId, selectedSystems: [...selectedSystems], paths: [...mergeSelectedFiles], origin: "workspace-review", message: mergeNote.trim() || "融合工作区发现的新修改" });
        const id = payloadId(value);
        if (!id) throw new Error("服务器没有返回融合草稿编号，未创建任何版本。");
        const draftValue = dict(value);
        draftRef.current = draftValue;
        setDraft(draftValue);
        const returnedFiles = normalizeFiles(value);
        // A draft is only a safe staging point. Do not confirm or commit here:
        // merge and update must share the same final, editable review page.
        editorSnapshotRef.current.clear();
        if (returnedFiles.length) {
          filesRef.current = returnedFiles;
          setFiles(returnedFiles);
        }
        const reviewFiles = returnedFiles.length ? returnedFiles : files;
        setAiFiles(new Set(aiEditableFileIds(reviewFiles)));
        setMergeSelectedFiles(new Set(reviewFiles.map((file) => file.path)));
        replaceConfirmedFiles([]);
        busyRef.current = "";
        setBusy("");
        navigate("update-result");
      });
    } finally {
      writeBusyRef.current = false;
    }
  }, [activePlanId, aiInputToken, canMutateProductInputNow, comparison, files, flow, mergeNote, mergeSelectedFiles, navigate, replaceConfirmedFiles, resetAiForNewFlow, safeAction, selectedSystems, workspace]);

  const createLibraryDraft = useCallback(async (action: "edit" | "create" | "delete", path: string, content = "", inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    // resetAiForNewFlow is async even when the composer is idle. Close the
    // write gate before that first await so two same-tick library entries
    // cannot both reach safeAction.
    writeBusyRef.current = true;
    try {
      if (!await resetAiForNewFlow(`library:${action}:${path}`)) return false;
      writeBusyRef.current = false;
      await safeAction(action === "create" ? "正在准备新文件预览" : action === "delete" ? "正在准备删除预览" : "正在准备中心库编辑草稿", async () => {
        if (!activePlanId) throw new Error("中心库尚未返回项目方案编号。");
        const value = await api.libraryDraft({
          planId: activePlanId,
          action,
          path,
          content,
          origin: action === "create" ? "library-create" : action === "delete" ? "library-delete" : "library-manual-edit",
          message: action === "create" ? `创建文件 ${path}` : action === "delete" ? `删除文件 ${path}` : `手动编辑 ${path}`,
        });
        const nextFiles = normalizeFiles(value);
        editorSnapshotRef.current.clear();
        const draftValue = dict(value);
        draftRef.current = draftValue;
        setDraft(draftValue);
        filesRef.current = nextFiles;
        setFiles(nextFiles);
        setAiFiles(new Set(aiEditableFileIds(nextFiles)));
        replaceConfirmedFiles(nextFiles.filter((file) => file.confirmed).map((file) => file.id));
        setFlow("update");
        busyRef.current = "";
        setBusy("");
        navigate("update-result");
      });
    } finally {
      writeBusyRef.current = false;
    }
  }, [activePlanId, aiInputToken, canMutateProductInputNow, navigate, replaceConfirmedFiles, resetAiForNewFlow, safeAction]);

  const processAi = useCallback(async (fromResult = false, selectedOverride?: Set<string>) => {
    // The gate is the synchronous boundary.  It closes before the first
    // await, so a same-tick second click cannot supersede the submitted
    // request even before React has rendered the readOnly textarea.
    if (!canMutateProductInputNow()) return;
    const submittedPrompt = String(fromResult ? resultPrompt : aiPrompt);
    if (!submittedPrompt.trim()) return setError("请告诉 AI 你希望如何处理这些文件。");
    const currentFiles = filesRef.current.length ? filesRef.current : files;
    const requested = [...(selectedOverride || aiFiles)];
    const selected = requested.filter((fileId) => isAiEditableFile(currentFiles.find((file) => file.id === fileId)));
    if (!selected.length) return setError("请至少勾选一个要交给 AI 的文件。");
    const selectedPaths = selected
      .map((fileId) => currentFiles.find((file) => file.id === fileId)?.path)
      .filter((path): path is string => Boolean(path));
    if (selectedPaths.length !== selected.length) return setError("所选文件已经不在当前差异范围内，请重新选择后重试。");
    aiInputLockRef.current = true;
    const operationId = createPanelRequestId("draft-ai");
    const currentScope = aiRequestGateRef.current.currentScope();
    const nextScope = {
      flowId: currentScope.flowId || `${flow}:${workspace?.path || "current"}`,
      draftId: payloadId(draft),
      fileIds: selected,
    };
    const comparisonId = stringValue(comparison?.comparisonId, comparison?.id);
    const planId = activePlanId;
    const workspacePath = workspace?.path || "";
    const promptKind = fromResult ? "result" : "draft";
    const beforeScopeKey = currentScope.scopeKey;
    const previous = aiRequestGateRef.current.setScope(nextScope);
    if (previous === false) {
      aiInputLockRef.current = false;
      return;
    }
    if (previous) void cancelAiRequest(previous).catch(() => {});
    const scopeChanged = beforeScopeKey !== aiRequestGateRef.current.currentScope().scopeKey;
    if (scopeChanged) {
      // A newly materialized draft is a new scope, but the click still owns
      // this submitted field.  Carry only that field into its new request;
      // the other composer is deliberately cleared.
      if (!aiRequestGateRef.current.clearPromptState()) {
        aiInputLockRef.current = false;
        return;
      }
      if (!aiRequestGateRef.current.setPrompt(promptKind, submittedPrompt, aiRequestGateRef.current.inputToken())) {
        aiInputLockRef.current = false;
        return;
      }
      setAiPromptValue(fromResult ? "" : submittedPrompt);
      setResultPromptValue(fromResult ? submittedPrompt : "");
    }
    updateAiInstructionScope((current) => {
      const transitioned = transitionAiInstructionScope(current, nextScope);
      return scopeChanged
        ? { ...transitioned, prompt: fromResult ? "" : submittedPrompt, resultPrompt: fromResult ? submittedPrompt : "" }
        : { ...transitioned, prompt: current.prompt, resultPrompt: current.resultPrompt };
    });
    const started = aiRequestGateRef.current.begin({
      prompt: submittedPrompt,
      promptKind,
      operationId,
      filePaths: selectedPaths,
      comparisonId,
      planId,
      workspacePath,
    });
    if (!started.request) {
      aiInputLockRef.current = false;
      return;
    }
    const { request } = started;
    const snapshot = request.snapshot;
    aiComposerLockRef.current = true;
    const isCurrent = () => aiRequestGateRef.current.isCurrent(request);
    setAiProcessing(true);
    setAiCancellable(true);
    try {
      await safeAction("正在生成 AI 草稿", async () => {
        if (!isCurrent()) return;
        let activeDraft = draft;
        let id = snapshot.draftId;
        const signal = request.controller?.signal;
        if (!id) {
          if (!snapshot.comparisonId) throw new Error("没有比较编号，无法创建编辑草稿。");
          activeDraft = dict(await api.libraryDraft({ comparisonId: snapshot.comparisonId, planId: snapshot.planId, paths: snapshot.filePaths, origin: "workspace-review" }, { signal }));
          if (!isCurrent()) return;
          id = payloadId(activeDraft);
          if (!id) throw new Error("服务器没有返回草稿编号，当前没有写入。");
          draftRef.current = activeDraft;
          setDraft(activeDraft);
        }
        if (!isCurrent()) return;
        const value = dict(await api.draftAi({ draftId: id, message: snapshot.prompt.trim(), selectedFiles: snapshot.filePaths, comparisonId: snapshot.comparisonId, workspacePath: snapshot.workspacePath, requestId: snapshot.operationId }, { signal }));
        if (!isCurrent()) return;
        if (value.cancelled) return;
        const session = dict(first(value.session, value));
        const sessionId = stringValue(value.chatId, value.sessionId, session.id);
        if (!sessionId) throw new Error("AI 没有返回处理会话，当前没有读取旧草稿。");
        if (!aiRequestGateRef.current.attachSession(request, sessionId)) return;
        if (!isCurrent()) return;
        setConversationId(sessionId);
        let status = await readChatStatusWithRetry(sessionId, signal);
        if (!isCurrent()) return;
        let completed = ["completed", "succeeded"].includes(stringValue(status.session?.status, status.status).toLowerCase());
        for (let attempt = 0; attempt < 120 && !completed && !["failed", "cancelled", "canceled"].includes(stringValue(status.session?.status, status.status).toLowerCase()); attempt += 1) {
          if (!isCurrent()) return;
          await waitFor(1000, signal);
          if (!isCurrent()) return;
          status = await readChatStatusWithRetry(sessionId, signal);
          if (!isCurrent()) return;
          completed = ["completed", "succeeded"].includes(stringValue(status.session?.status, status.status).toLowerCase());
        }
        if (!isCurrent()) return;
        const statusValue = stringValue(status.session?.status, status.status).toLowerCase();
        if (["failed", "cancelled", "canceled"].includes(statusValue)) throw new Error(stringValue(status.session?.error, "AI 处理未完成"));
        if (!completed) throw new Error("AI 仍在处理，当前没有读取旧草稿。请稍后重试或查看助手状态。");
        // Read one structured draft snapshot after the session completes. This
        // carries file context, diff metadata and confirmation state together,
        // and avoids appending the same assistant/file response on every poll.
        const refreshedDraft = dict(await api.draft(id, { signal }));
        if (!isCurrent()) return;
        const refreshedFiles = normalizeFiles(refreshedDraft);
        const selectedPathSet = new Set(snapshot.filePaths);
        const currentScopedFiles = (filesRef.current.length ? filesRef.current : normalizeFiles(activeDraft)).filter((file) => selectedPathSet.has(file.path));
        const scopedRefreshedFiles = refreshedFiles.filter((file) => selectedPathSet.has(file.path));
        const nextFiles = scopedRefreshedFiles.length ? scopedRefreshedFiles : currentScopedFiles;
        if (!isCurrent()) return;
        editorSnapshotRef.current.clear();
        filesRef.current = nextFiles;
        setFiles(nextFiles);
        setAiFiles(new Set(aiEditableFileIds(nextFiles)));
        draftRef.current = refreshedDraft;
        setDraft(refreshedDraft);
        replaceConfirmedFiles([]);
         navigate("update-result", false, "ai-success");
      }, undefined, isCurrent);
    } finally {
      if (isCurrent()) {
        aiRequestGateRef.current.finish(request);
        aiComposerLockRef.current = false;
        aiInputLockRef.current = false;
        setAiProcessing(false);
        setAiCancellable(false);
      }
    }
  }, [activePlanId, aiFiles, aiPrompt, canMutateProductInputNow, cancelAiRequest, comparison, draft, files, flow, navigate, replaceConfirmedFiles, resultPrompt, safeAction, updateAiInstructionScope, workspace]);

  const cancelAi = useCallback(async () => {
    const cancellation = aiRequestGateRef.current.beginCancelSettlement();
    const request = cancellation.request;
    const settlement = cancellation.settlement;
    if (!request || !settlement) return;
    aiComposerLockRef.current = true;
    aiInputLockRef.current = true;
    cancellationBusyRef.current = settlement;
    setAiCancelSettling(true);
    const restored = aiRequestGateRef.current.restoreCancelledPrompt(request);
    if (!restored || !aiRequestGateRef.current.markCancelRestoreCommitted(settlement)) {
      aiRequestGateRef.current.failCancelSettlement(settlement, "取消前的 prompt 恢复未完成");
      if (cancellationBusyRef.current === settlement) cancellationBusyRef.current = null;
      setAiCancelSettling(false);
      setAiProcessing(false);
      setAiCancellable(false);
      if (!writeBusyRef.current) {
        busyRef.current = "";
        setBusy("");
      }
      aiComposerLockRef.current = true;
      setError("取消 AI 处理未完成，当前草稿已安全锁定。请切换到新的文件范围后重试。");
      return;
    }
    setAiPromptValue(restored.aiPrompt);
    setResultPromptValue(restored.resultPrompt);
    updateAiInstructionScope((current) => ({
      ...current,
      flowId: request.flowId,
      draftId: request.draftId,
      fileIds: [...request.fileIds],
      scopeKey: request.scopeKey,
      prompt: restored.aiPrompt,
      resultPrompt: restored.resultPrompt,
    }));
    setAiProcessing(false);
    setAiCancellable(false);
    setError("已取消 AI 处理；当前草稿仍保留，尚未保存为中心库版本。");
    await settleAiCancellation(request, settlement);
  }, [settleAiCancellation, updateAiInstructionScope]);

  const saveFile = useCallback(async (fileId: string, content: string, inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    const file = filesRef.current.find((item) => item.id === fileId);
    if (!file) return false;
    rememberEditorSnapshot(fileId, file.path, content, inputToken);
    let saved = false;
    writeBusyRef.current = true;
    try {
      await safeAction("正在保存文件草稿", async () => {
        const currentDraft = draftRef.current;
        if (currentDraft) {
          const nextDraft = {
            ...currentDraft,
            files: array(currentDraft.files).map((item) => dict(item).id === fileId || dict(item).fileId === fileId
              ? { ...dict(item), content, finalContent: content }
              : item),
          };
          draftRef.current = nextDraft;
          setDraft(nextDraft);
        }
        const value = await api.draftFile({ draftId: payloadId(draftRef.current), fileId, path: file.path, content, finalContent: content });
        const returnedFiles = normalizeFiles(value);
        if (returnedFiles.length) {
          const merged = mergeDraftFiles(filesRef.current, returnedFiles);
          filesRef.current = merged;
          setFiles(merged);
        }
        setError("");
        saved = true;
      }, (formatted) => {
        setError(`${formatted.message} 草稿仍保留在当前页面，尚未合并。`);
        setErrorDetails(formatted.technical);
      });
    } finally {
      writeBusyRef.current = false;
    }
    return saved;
  }, [aiInputToken, canMutateProductInputNow, rememberEditorSnapshot, safeAction]);

  const confirmFile = useCallback(async (fileId: string, inputToken = aiInputToken) => {
    const currentFile = filesRef.current.find((item) => item.id === fileId);
    const pendingSave = editorIntentQueueRef.current.pendingSave(fileId, inputToken);
    const deletionBodyAvailable = !currentFile?.deleted || currentFile.originalContentAvailable !== false;
    if (!currentFile || !deletionBodyAvailable || inputToken !== aiRequestGateRef.current.inputToken() || (!canMutateProductInputNow() && !pendingSave)) return false;
    const next = !confirmedFilesRef.current.has(fileId);
    return editorIntentQueueRef.current.confirm(fileId, inputToken, {
      isCurrent: () => inputToken === aiRequestGateRef.current.inputToken(),
      canStart: canMutateProductInputNow,
      snapshot: () => {
        const file = filesRef.current.find((item) => item.id === fileId) || currentFile;
        return currentEditorContent(file, inputToken);
      },
      confirm: async ({ persisted, snapshot }: { persisted: boolean; snapshot?: unknown }) => {
        if (!canMutateProductInputNow()) return false;
        let confirmed = false;
        writeBusyRef.current = true;
        try {
          await safeAction(next ? "正在确认文件" : "正在撤销确认", async () => {
            const file = filesRef.current.find((item) => item.id === fileId);
            if (!file) throw new Error("没有找到要确认的文件。");
            const body: Dict = {
              draftId: payloadId(draftRef.current),
              fileId,
              path: file.path,
              confirmed: next,
            };
            // A deletion is a human-reviewed tombstone. Never route its
            // displayed body through an editable content payload; the server
            // still performs the missing-body fail-closed check at commit.
            if (next && file.deleted && file.originalContentAvailable !== false && typeof file.originalContent === "string") {
              // This is an immutable echo used to prove that the person
              // reviewed the current center-library body. It is not an edit
              // payload and the tombstone remains outside the AI editable set.
              body.originalContent = file.originalContent;
            }
            if (next && !file.deleted) {
              const content = typeof snapshot === "string" ? snapshot : currentEditorContent(file, inputToken);
              body.content = content;
              body.finalContent = content;
              body.persistedBeforeConfirm = persisted;
            }
            const response = dict(await api.draftConfirm(body));
            if (inputToken !== aiRequestGateRef.current.inputToken()) return;
            // draftConfirm returns the authoritative draft. Apply it to both
            // refs synchronously before React renders so the immediately
            // following save/commit cannot serialize the pre-confirmed file.
            const returnedDraft = dict(first(response.draft, response.result, response.data, response));
            const returnedFiles = normalizeFiles(returnedDraft);
            const returnedFile = returnedFiles.find((item) => item.path === file.path || item.id === fileId);
            const serverConfirmed = returnedFile && typeof returnedFile.confirmed === "boolean" ? returnedFile.confirmed : null;
            if (next && serverConfirmed === false) throw new Error("服务器未确认这次文件审阅，当前没有保存新版本。");
            if (payloadId(returnedDraft)) {
              draftRef.current = returnedDraft;
              setDraft(returnedDraft);
            }
            const nextConfirmed = new Set(confirmedFilesRef.current);
            const effectiveConfirmed = serverConfirmed === null ? next : serverConfirmed;
            if (effectiveConfirmed) nextConfirmed.add(fileId); else nextConfirmed.delete(fileId);
            confirmedFilesRef.current = nextConfirmed;
            setConfirmedFiles(nextConfirmed);
            const mergedFiles = returnedFiles.length ? mergeDraftFiles(filesRef.current, returnedFiles) : filesRef.current;
            const nextFiles = mergedFiles.map((item) => {
              if (item.id !== fileId && item.path !== file.path) return item;
              return {
                ...item,
                ...(typeof body.content === "string" ? { finalContent: body.content } : {}),
                confirmed: effectiveConfirmed,
              };
            });
            filesRef.current = nextFiles;
            setFiles(nextFiles);
            if (!file.deleted && typeof body.content === "string") rememberEditorSnapshot(fileId, file.path, body.content, inputToken);
            confirmed = true;
          });
        } finally {
          writeBusyRef.current = false;
        }
        return confirmed;
      },
    });
  }, [aiInputToken, canMutateProductInputNow, currentEditorContent, rememberEditorSnapshot, safeAction]);

  const commitUpdate = useCallback(async (inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken()) return false;
    if (!canMutateProductInputNow()) {
      const pendingConfirmations = filesRef.current
        .map((file) => editorIntentQueueRef.current.pendingConfirmation(file.id))
        .filter(Boolean);
      if (!pendingConfirmations.length) return false;
      await Promise.allSettled(pendingConfirmations);
      if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    }
    const activeDraft = draftRef.current || draft;
    if (!activeDraft && !comparison) return setError("没有可提交的草稿。");
    let currentFiles = filesRef.current.length ? filesRef.current : files;
    let currentConfirmed = new Set(confirmedFilesRef.current);
    // Re-read the draft immediately before commit. This closes the small
    // React/render gap after the first confirmation click and makes the
    // server's confirmed flags the source of truth for the manifest write.
    const activeDraftId = payloadId(activeDraft);
    if (activeDraftId) {
      try {
        const freshDraft = dict(await api.draft(activeDraftId));
        if (inputToken !== aiRequestGateRef.current.inputToken()) return false;
        const freshFiles = normalizeFiles(freshDraft);
        if (freshFiles.length) {
          const freshUnconfirmed = freshFiles.filter((file) => file.confirmed === false);
          if (freshUnconfirmed.length) {
            const mergedFresh = mergeDraftFiles(currentFiles, freshFiles);
            filesRef.current = mergedFresh;
            setFiles(mergedFresh);
            const serverConfirmed = new Set(freshFiles
              .filter((file) => file.confirmed)
              .map((file) => mergedFresh.find((candidate) => candidate.path === file.path || candidate.id === file.id)?.id || file.id));
            replaceConfirmedFiles(serverConfirmed);
            setError("服务器仍有文件未确认，请重新查看后再保存。");
            return false;
          }
          draftRef.current = freshDraft;
          setDraft(freshDraft);
          currentFiles = mergeDraftFiles(currentFiles, freshFiles);
          filesRef.current = currentFiles;
          currentConfirmed = new Set([
            ...currentConfirmed,
            ...freshFiles
              .filter((file) => file.confirmed)
              .map((file) => currentFiles.find((candidate) => candidate.path === file.path || candidate.id === file.id)?.id || file.id),
          ]);
          replaceConfirmedFiles(currentConfirmed);
          setFiles(currentFiles);
        }
      } catch {
        // The current draft response remains usable if a read races a
        // transient service restart; the commit endpoint still validates it.
      }
    }
    if (currentFiles.length && currentConfirmed.size !== currentFiles.length) return setError("请先确认每个有修改的文件，或逐个检查后再合并。");
    const origin = stringValue(activeDraft?.origin);
    const centerOnly = isLibraryDraftOrigin(origin);
    const transaction = beginDraftSaveTransaction({
      origin,
      flow,
      busy: centerOnly ? "正在保存中心库版本" : "正在合并回中心库",
    });
    setSaveTransaction(transaction);
    writeBusyRef.current = true;
    let committed = false;
    try {
      await safeAction(transaction.busy, async () => {
        if (centerOnly) {
          busyRef.current = "正在保存中心库版本";
          setBusy("正在保存中心库版本");
        }
        const message = mergeNote.trim() || (origin === "library-create" ? `创建文件 ${stringValue(activeDraft?.preview?.targetPath, "草稿")}` : origin === "library-delete" ? `删除文件 ${stringValue(activeDraft?.preview?.targetPath, "草稿")}` : origin === "library-manual-edit" ? "中心库手动编辑" : flow === "connect" ? "融合工作区发现的新修改" : "保存工作区更新");
        const value = dict(await api.draftCommit({ draftId: payloadId(activeDraft), comparisonId: stringValue(comparison?.id, comparison?.comparisonId), workspacePath: workspace?.path, confirmedFileIds: [...currentConfirmed], message }));
        const receipt = receiptFromCommit(value, origin, {
          planId: stringValue(activeDraft?.planId, activePlanId),
          workspacePath: workspace?.path,
          draftId: payloadId(activeDraft),
          fileCount: currentFiles.length,
        });
        if (receipt) {
          mergeReceiptRef.current = retainAuthoritativeReceipt(mergeReceiptRef.current, receipt);
          persistProductReceipt(mergeReceiptRef.current);
        }
        const committedDraft = dict(value.draft);
        if (Object.keys(committedDraft).length) {
          draftRef.current = committedDraft;
          setDraft(committedDraft);
        }
        if (centerOnly) resetNewDraftForm();
        // Invalidate immediately after the authoritative commit succeeds so a
        // refresh failure can never leave the old body looking current.
        setActiveFile((current) => invalidateLibraryDetail(current));
        await refreshOverview();
        await refreshLibrary();
        // The write gate is complete before the success screen is shown.
        writeBusyRef.current = false;
        busyRef.current = "";
        setBusy("");
        navigate(transaction.flow === "connect" ? "merge-success" : "update-success", true, "user", receipt);
        committed = true;
      });
    } finally {
      writeBusyRef.current = false;
      setSaveTransaction(null);
    }
    return committed;
  }, [activePlanId, aiInputToken, canMutateProductInputNow, comparison, draft, files, flow, mergeNote, navigate, refreshLibrary, refreshOverview, replaceConfirmedFiles, resetNewDraftForm, safeAction, workspace]);

  const previewTakeover = useCallback(async (targetProjection = "") => {
    if (!workspace?.path) return setError("请先选择工作区。");
    if (!await resetAiForNewFlow(`takeover:${workspace.path}`)) return;
    await safeAction("正在生成接管预览", async () => {
      if (!activePlanId) throw new Error("中心库尚未返回项目方案编号，无法生成接管预览。");
      const value = await api.takeoverPreview({
        planId: activePlanId,
        versionId: activeVersion,
        worktreePath: workspace.path,
        workspacePath: workspace.path,
        selectedSystemIds: workspace.selectedSystemIds?.length ? workspace.selectedSystemIds : [...selectedSystems],
        ...(targetProjection ? { targetProjection } : {}),
      });
      const raw = dict(value);
      comparisonRef.current = raw;
      setComparison(raw);
      if (array(raw.selectedSystemIds).length) {
        setWorkspace((current) => current ? { ...current, selectedSystemIds: array(raw.selectedSystemIds).map(String), selectedSystemRefs: array(raw.selectedSystemRefs).map(dict) } : current);
      }
      setConfirmDirtyTakeover(false);
      busyRef.current = "";
      setBusy("");
      navigate("takeover");
    });
  }, [activePlanId, activeVersion, navigate, resetAiForNewFlow, safeAction, selectedSystems, workspace]);

  const applyTakeover = useCallback(async (inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    if (!workspace?.path) return setError("没有可接管的工作区。");
    writeBusyRef.current = true;
    try {
      await safeAction("正在应用中心库", async () => {
        // Read the latest approved preview from the synchronous ref. A route
        // snapshot can be one render behind after choosing a target projection;
        // applying that stale preview is what caused the first-confirmation
        // “workspace changed” false positive.
        const approvedPreview = comparisonRef.current || comparison || {};
        const value = await api.takeoverApply({ previewId: stringValue(approvedPreview.id, approvedPreview.previewId), planHash: stringValue(approvedPreview.planHash), targetProjection: stringValue(approvedPreview.targetProjection), canonicalTarget: stringValue(approvedPreview.canonicalTarget), selectedSystemIds: array(approvedPreview.selectedSystemIds).map(String), selectedSystemRefs: array(approvedPreview.selectedSystemRefs).map(dict), confirmDirty: confirmDirtyTakeover });
        const raw = dict(value);
        const approved = preserveApprovedTakeoverPreview(approvedPreview, raw);
        comparisonRef.current = approved;
        setComparison(approved);
        if (dict(raw.workspace).path) setWorkspace(workspaceFrom(raw.workspace));
        await refreshOverview();
        writeBusyRef.current = false;
        busyRef.current = "";
        setBusy("");
        setTakeoverStatus("checking");
        navigate("takeover-success", true);
      });
    } finally {
      writeBusyRef.current = false;
    }
  }, [aiInputToken, canMutateProductInputNow, comparison, confirmDirtyTakeover, navigate, refreshOverview, safeAction, workspace]);

  const rollbackTakeover = useCallback(async (inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    if (takeoverStatus !== "active" || takeoverStatusChecking) {
      setError("无法确认这次接管的当前状态，已禁用回滚。请返回首页后重试。");
      return false;
    }
    const protectionId = stringValue(comparison?.protectionId, workspace?.protectionId);
    if (!protectionId) return setError("这次接管已经回滚，当前没有可用的旧回滚点。");
    writeBusyRef.current = true;
    try {
      await safeAction("正在回滚接管", async () => {
        await api.takeoverRollback({ protectionId });
        await refreshOverview();
        writeBusyRef.current = false;
        busyRef.current = "";
        setBusy("");
        navigate("home");
      });
    } finally {
      writeBusyRef.current = false;
    }
    return true;
  }, [aiInputToken, canMutateProductInputNow, comparison?.protectionId, navigate, refreshOverview, safeAction, takeoverStatus, takeoverStatusChecking, workspace?.protectionId]);

  const sendChat = useCallback(async (event: React.FormEvent, fromHome = false) => {
    event.preventDefault();
    if (!canEditChatInput(chatInputToken)) return;
    const body = chatDraft.trim();
    if (!body) return;
    const operationId = createPanelRequestId("assistant-chat");
    const previous = chatRequestGateRef.current.setScope({ flowId: `assistant:${conversationId || "new"}`, draftId: "", fileIds: [] });
    void cancelAiRequest(previous).catch(() => {});
    const started = chatRequestGateRef.current.begin({ prompt: body, promptKind: "assistant", operationId });
    if (!started.request) return;
    const { request } = started;
    const isCurrent = () => chatRequestGateRef.current.isCurrent(request);
    if (conversationId) chatRequestGateRef.current.attachSession(request, conversationId);
    setChatDraftValue("");
    setChatMessages((current) => [...current, { role: "user", body }]);
    try {
      await safeAction("正在准备回答", async () => {
        if (!isCurrent()) return;
        const signal = request.controller?.signal;
        const value = dict(await api.chat({ ...(conversationId ? { sessionId: conversationId } : {}), message: body, prompt: body, requestId: operationId, context: { workspacePath: workspace?.path, screen } }, { signal }));
        if (!isCurrent()) return;
        const raw = value;
        const session = dict(first(raw.session, raw));
        const id = stringValue(raw.chatId, raw.sessionId, raw.conversationId, raw.id, session.id);
        if (id && !chatRequestGateRef.current.attachSession(request, id)) return;
        if (id && isCurrent()) setConversationId(id);
        let answer = stringValue(raw.answer, raw.reply, raw.assistantMessage, raw.text, dict(raw.response).text);
        if (!answer && id) {
          let status = await readChatStatusWithRetry(id, signal);
          if (!isCurrent()) return;
          let completed = ["completed", "succeeded"].includes(stringValue(status.session?.status, status.status).toLowerCase());
          for (let attempt = 0; attempt < 120 && !completed && !["failed", "cancelled", "canceled"].includes(stringValue(status.session?.status, status.status).toLowerCase()); attempt += 1) {
            if (!isCurrent()) return;
            await waitFor(1000, signal);
            if (!isCurrent()) return;
            status = await readChatStatusWithRetry(id, signal);
            if (!isCurrent()) return;
            completed = ["completed", "succeeded"].includes(stringValue(status.session?.status, status.status).toLowerCase());
          }
          if (!isCurrent()) return;
          const statusValue = stringValue(status.session?.status, status.status).toLowerCase();
          if (["failed", "cancelled", "canceled"].includes(statusValue)) throw new Error(stringValue(status.session?.error, "AI 对话未完成"));
          if (!completed) throw new Error("AI 仍在处理，当前没有显示旧回答。请稍后重试或查看技术详情。");
          answer = stringValue(status.assistantMessage, status.answer, status.reply);
        }
        if (!answer) throw new Error("AI 没有返回可显示的回答，请稍后重试。");
        if (!isCurrent()) return;
        setChatMessages((current) => [...current, { role: "assistant", body: answer }]);
        if (fromHome && isCurrent()) {
          // The chat request has produced its authoritative answer. Finish
          // that token before the home shortcut navigates, so the success
          // transition does not bypass the still-running chat lock.
          chatRequestGateRef.current.finish(request);
          busyRef.current = "";
          setBusy("");
          navigate("assistant");
        }
      }, undefined, isCurrent);
    } finally {
      if (isCurrent()) chatRequestGateRef.current.finish(request);
    }
  }, [canEditChatInput, chatDraft, chatInputToken, cancelAiRequest, conversationId, navigate, safeAction, screen, workspace?.path]);

  const refreshConversation = useCallback(async () => {
    if (!conversationId) return;
    if (!canMutateProductInputNow() || chatRequestGateRef.current.isLocked()) return;
    const sessionId = conversationId;
    const operationId = createPanelRequestId("assistant-refresh");
    const previous = chatRequestGateRef.current.setScope({ flowId: `assistant:${sessionId}`, draftId: "", fileIds: [] });
    void cancelAiRequest(previous).catch(() => {});
    const started = chatRequestGateRef.current.begin({ promptKind: "assistant-refresh", operationId });
    if (!started.request) return;
    const { request } = started;
    const isCurrent = () => chatRequestGateRef.current.isCurrent(request);
    chatRequestGateRef.current.attachSession(request, sessionId);
    try {
      await safeAction("正在读取状态", async () => {
        const status = await readChatStatusWithRetry(sessionId, request.controller?.signal);
        if (!isCurrent()) return;
        const state = stringValue(status.session?.status, status.status).toLowerCase();
        if (["failed", "cancelled", "canceled"].includes(state)) {
          throw new Error(stringValue(status.session?.error, "AI 对话未完成"));
        }
        const answer = stringValue(status.assistantMessage, status.answer, status.reply);
        if (answer && isCurrent()) {
          setChatMessages((current) => current.some((message) => message.role === "assistant" && message.body === answer)
            ? current
            : [...current, { role: "assistant", body: answer }]);
        }
      }, undefined, isCurrent);
    } finally {
      if (isCurrent()) chatRequestGateRef.current.finish(request);
    }
  }, [canMutateProductInputNow, cancelAiRequest, conversationId, safeAction]);

  const settleChatCancellation = useCallback(async (cancellation: any) => {
    const request = cancellation?.request;
    const settlement = cancellation?.settlement;
    if (!request || !settlement) return true;
    const results = await Promise.allSettled([
      cancelAiRequest(request),
      waitForUiSettlementBoundary(),
    ]);
    const cancelResult = results[0];
    if (cancelResult.status === "rejected") {
      chatRequestGateRef.current.settleCancellation(settlement, {
        success: false,
        failure: errorTechnicalDetails(cancelResult.reason),
      });
      // A failed remote cancel cannot unlock the old conversation scope. Move
      // to an explicit isolated scope before allowing another submit.
      chatRequestGateRef.current.recoverFailedCancellation({
        flowId: `assistant:isolated:${settlement.operationId || "cancel"}`,
        draftId: "",
        fileIds: [],
      });
      if (chatCancellationBusyRef.current === settlement) {
        chatCancellationBusyRef.current = null;
        busyRef.current = "";
        setBusy("");
      }
      setError("上一条对话未能安全取消，旧对话已隔离。请重新发送或再次开启新对话。");
      setErrorDetails(errorTechnicalDetails(cancelResult.reason));
      setChatMessages([]);
      setConversationId("");
      setChatDraftValue("");
      return false;
    }
    const settled = chatRequestGateRef.current.settleCancellation(settlement, {
      success: true,
    });
    if (settled && chatCancellationBusyRef.current === settlement) {
      chatCancellationBusyRef.current = null;
      busyRef.current = "";
      setBusy("");
    }
    return settled;
  }, [cancelAiRequest]);

  const startNewChat = useCallback(async () => {
    const chatActive = Boolean(chatRequestGateRef.current.current());
    if (aiRequestGateRef.current.isLocked() || writeBusyRef.current || chatCancellationBusyRef.current
      || (!chatActive && (chatRequestGateRef.current.isLocked() || Boolean(busyRef.current)))) return false;
    const cancellation = chatRequestGateRef.current.beginCancelSettlement();
    if (cancellation.rejected) return false;
    setBusy("");
    busyRef.current = "";
    setError("");
    setErrorDetails("");
    setChatMessages([]);
    setConversationId("");
    setChatDraftValue("");
    if (!cancellation.request || !cancellation.settlement) return true;
    chatCancellationBusyRef.current = cancellation.settlement;
    busyRef.current = "正在结束上一条对话";
    setBusy("正在结束上一条对话");
    return settleChatCancellation(cancellation);
  }, [settleChatCancellation]);

  const cancelFlow = useCallback(async () => {
    if (writeBusyRef.current) {
      setError("当前正在保存或提交，请等待完成后再离开。");
      return false;
    }
    pickerRequestRef.current += 1;
    const aiReset = await resetAiForNewFlow("cancelled");
    if (!aiReset) return false;
    const cancellation = chatRequestGateRef.current.beginCancelSettlement();
    if (cancellation.rejected) return false;
    if (cancellation.request && cancellation.settlement) {
      chatCancellationBusyRef.current = cancellation.settlement;
      busyRef.current = "正在结束上一条对话";
      setBusy("正在结束上一条对话");
      if (!await settleChatCancellation(cancellation)) return false;
    }
    if (!canNavigateNow("cancel")) return false;
    return navigate(overview?.initialized ? "home" : "welcome", false, "cancel");
  }, [canNavigateNow, navigate, overview?.initialized, resetAiForNewFlow, settleChatCancellation]);

  const enterEmptyHome = useCallback(async () => {
    try {
      window.sessionStorage.setItem(SKIP_INITIALIZATION_KEY, "1");
    } catch {
      // Navigation still works when the browser blocks session storage.
    }
    setWorkspace(null);
    setAnalysis(null);
    setSystems([]);
    setSelectedSystems(new Set());
    if (!await resetAiForNewFlow("empty-home")) return;
    navigate("home");
  }, [navigate, resetAiForNewFlow]);

  // The library is a real versioned workspace: every create/edit/delete path
  // enters the same preview -> confirm -> new-version flow. Keep this view
  // intentionally explicit so the default page never hides a destructive
  // action behind an inert button.
  const renderTakeoverLegacy = () => renderTakeoverV2();

  const renderTakeoverV2 = () => {
    const preview = comparison || {};
    const operations = array(preview.operations);
    const summary = takeoverSummaryModel(preview);
    const unavailable = array(preview.unavailable).map(dict);
    const targetOptions = array(preview.targetOptions).map(dict);
    const selectedTarget = targetOptions.find((item) => Boolean(item.selected)) || targetOptions.find((item) => stringValue(item.value) === stringValue(preview.targetProjection));
    const selectedCanonicalTarget = stringValue(selectedTarget?.canonicalTargetDirectory, selectedTarget?.canonicalTarget, preview.canonicalTargetDirectory, preview.canonicalTarget);
    const requiresExplicit = Boolean(preview.requiresExplicit);
    const dirtyFiles = array(preview.dirtyFiles).map(String);
    const canApply = preview.available !== false && unavailable.length === 0 && operations.every((operation) => dict(operation).available !== false);
    return (
      <FlowChrome activeStep={4} variant="takeover" title="确认中心库将如何接管" subtitle="连接工作区 · 接管预览" onCancel={cancelFlow}>
        <div className="takeover-warning"><span>!</span><div><strong>这一步会写入工作区</strong><p>先确认保全范围；项目私有内容和未列入预览的文件不会自动处理。</p></div></div>
        {targetOptions.length ? <section className="takeover-target-picker card">
          <label htmlFor="takeover-target-projection"><strong>选择工作区内部的规范目标</strong><select id="takeover-target-projection" data-testid="takeover-target-projection" value={stringValue(preview.targetProjection, selectedTarget?.value)} onChange={(event) => void previewTakeover(event.target.value)} disabled={Boolean(busy)}>{targetOptions.map((item, index) => <option key={stringValue(item.value, index)} value={stringValue(item.value)} disabled={item.available === false}>{stringValue(item.label, item.value)}</option>)}</select></label>
          <p data-testid="takeover-canonical-target">{selectedCanonicalTarget ? `将写入工作区内的规范目标目录：${selectedCanonicalTarget}` : "接管只会写入所选工作区内部目标；外部链接不会提供为可选项。"}</p>
        </section> : null}
        {unavailable.length ? <section className="takeover-unavailable card" role="alert"><strong>当前目标不能安全接管</strong><p>以下投影在确认前已标记不可用，请从上面的规范目标选择器重试。</p>{unavailable.map((item, index) => <div key={`${item.path}-${index}`}><code>{stringValue(item.path)}</code><span>{stringValue(item.reason, "目标包含链接")}</span></div>)}</section> : null}
        <div className="takeover-grid">
          <section className="takeover-column card"><div className="column-title"><span>库</span><div><strong>中心库将提供</strong><small>{overview?.libraryName || "中心库"}</small></div></div>{summary.groups.length ? summary.groups.map((group) => <article className="takeover-directory-summary" data-testid="takeover-directory-summary" key={group.key}><div className="takeover-directory-heading"><span>▣</span><div><strong>{group.name}</strong><small>{group.projection ? `规范目标 · ${group.projection}` : "规范目标目录"}</small></div></div><div className="takeover-directory-counts"><span><strong>{group.total}</strong><small>总计</small></span><span><strong>{group.create}</strong><small>新建</small></span><span><strong>{group.update}</strong><small>更新</small></span><span><strong>{group.keep}</strong><small>无需改动</small></span></div></article>) : <div className="path-item"><span>—</span><p><strong>没有可应用的目录</strong><code>{unavailable.length ? "请先选择可用的规范目标" : "请重新生成预览"}</code></p></div>}<details className="tech-details takeover-advanced-details" data-testid="takeover-advanced-details"><summary>查看实际写入路径（高级诊断）</summary>{summary.advancedItems.length ? <div className="takeover-advanced-list">{summary.advancedItems.map((item, index) => <div className="takeover-advanced-item" key={`${item.path}-${index}`}><span>{item.actionLabel}</span><p><strong>{item.path || `内容 ${index + 1}`}</strong><code>targetPath：{item.targetPath || "未返回"} · action：{item.action}</code></p></div>)}</div> : <p>当前预览没有可应用的 leaf 操作。</p>}</details></section>
          <section className="takeover-column card"><div className="column-title"><span>保</span><div><strong>明确保全</strong><small>不会自动处理</small></div></div><div className="path-item"><span>保留</span><p><strong>项目私有 Skill</strong><code>未经明确选择不覆盖</code></p></div><div className="path-item"><span>保留</span><p><strong>未列入预览的内容</strong><code>不删除、不清理</code></p></div></section>
          <section className="takeover-column card"><div className="column-title"><span>回</span><div><strong>可恢复</strong><small>应用后仍可回滚</small></div></div><div className="path-item"><span>记录</span><p><strong>接管前保全点</strong><code>由服务保存回滚边界</code></p></div></section>
        </div>
        {requiresExplicit && <label className="confirm-row card"><input type="checkbox" checked={confirmDirtyTakeover} onChange={(event) => setConfirmDirtyTakeover(event.target.checked)} /><span>预览中有 {dirtyFiles.length} 个本地已修改文件；我已逐项查看并明确同意按预览覆盖。</span></label>}
        <div className="protection-point card"><div><span>✓</span><p><strong>只应用预览中列出的中心库内容</strong><small>其它工作区内容保持不变。</small></p></div><button className="button button-dark" data-testid="apply-takeover" type="button" disabled={!canApply || Boolean(busy) || (requiresExplicit && !confirmDirtyTakeover)} onClick={() => void applyTakeover(aiInputToken)}>{busy || (canApply ? "确认接管" : "目标不可用")}</button></div>
      </FlowChrome>
    );
  };

  const previewRollback = useCallback(async (versionId: string) => {
    if (!await resetAiForNewFlow(`rollback:${versionId}`)) return;
    await safeAction("正在生成回滚预览", async () => {
      if (!activePlanId) throw new Error("中心库尚未返回项目方案编号。");
      const value = await api.rollbackPreview({ planId: activePlanId, versionId, message: `从 ${versionId} 回滚` });
      setRollbackPreview(dict(value));
      setRollbackAcknowledged(false);
    });
  }, [activePlanId, resetAiForNewFlow, safeAction]);

  const confirmRollback = useCallback(async (inputToken = aiInputToken) => {
    if (inputToken !== aiRequestGateRef.current.inputToken() || !canMutateProductInputNow()) return false;
    if (!rollbackPreview || !rollbackAcknowledged) return setError("请先确认已查看回滚范围和逐文件差异。");
    writeBusyRef.current = true;
    try {
      await safeAction("正在生成回滚版本", async () => {
        const value = await api.rollbackVersion({
          previewId: stringValue(rollbackPreview.previewId),
          planHash: stringValue(rollbackPreview.planHash),
          confirm: true,
          message: stringValue(rollbackPreview.message)
        });
        setRollbackPreview(null);
        setRollbackAcknowledged(false);
        setComparison(null);
        await refreshOverview();
        setLibrary(dict(await api.library()));
        if (value?.version?.versionId) setError("");
      });
    } finally {
      writeBusyRef.current = false;
    }
  }, [aiInputToken, canMutateProductInputNow, refreshOverview, rollbackAcknowledged, rollbackPreview, safeAction]);

  const renderLibraryLegacy = () => {
    const query = librarySearch.trim().toLowerCase();
    const visibleSystems = filteredSystems;
    const visibleFiles = filteredLibraryFiles;
    const active = (activeFile && visibleFiles.some((file) => file.path === activeFile.path) ? activeFile : visibleFiles[0]) || null;
    const rollbackFiles = rollbackPreview ? normalizeFiles(rollbackPreview) : [];
    const openSource = (item: System) => void safeAction("正在读取来源", async () => {
      if (!activePlanId) throw new Error("中心库尚未返回项目方案编号。");
      const value = await api.librarySource({ planId: activePlanId, systemId: item.id });
      setLibrarySource(dict(value));
    });
    const openFileFromSearch = (file: ChangeFile) => void openLibraryFile(file);
    return shell(<>
      {active && <section className="library-context-action card"><div><p className="card-kicker">当前文件</p><strong>{active.path}</strong><small>把这个文件作为上下文交给 AI，先生成可审阅草稿。</small></div><button className="button button-primary" data-testid="library-file-ai" type="button" onClick={() => void createLibraryDraft("edit", active.path, "", aiInputToken)}>✦ 让 AI 修改此文件</button></section>}
       <header className="page-title"><div><p className="eyebrow">中心库</p><h1>{overview?.libraryName || "中心库"}</h1><p>按项目方案查看 Skill、规则和来源；每次保存都会产生新的可回滚版本。</p></div><div className="page-actions"><button className="button button-primary" type="button" onClick={() => navigate("assistant")}>✦ 让 AI 修改</button><button className="button button-dark" type="button" onClick={() => { const next = startNewLibraryDraft(); setNewDraftOpen(next.open); setNewFilePath(next.path); setNewFileContent(next.content); setLibraryTab("files"); }}>＋ 新建文件草稿</button></div></header>
       {newDraftOpen && <section className="library-create card"><div><p className="card-kicker">中心库新建</p><h2>先填写文件草稿，再预览保存</h2><p>不会直接改动当前版本。确认后才会生成新的中心库版本。</p></div><label><span>文件路径</span><input data-testid="new-library-file-path" value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} placeholder="skills/example/SKILL.md" /></label><label><span>初始内容</span><textarea data-testid="new-library-file-content" value={newFileContent} onChange={(event) => setNewFileContent(event.target.value)} /></label><div className="action-row"><button className="button button-quiet" type="button" onClick={resetNewDraftForm}>取消</button><button className="button button-dark" data-testid="create-library-draft" type="button" disabled={!newFilePath.trim() || Boolean(busy)} onClick={() => void createLibraryDraft("create", newFilePath.trim(), newFileContent, aiInputToken)}>预览并继续</button></div></section>}
      <div className="library-tabs"><button className={libraryTab === "systems" ? "active" : ""} type="button" onClick={() => setLibraryTab("systems")}>项目方案与来源</button><button className={libraryTab === "files" ? "active" : ""} type="button" onClick={() => setLibraryTab("files")}>文件与规则 <span>{visibleFiles.length}</span></button><button className={libraryTab === "history" ? "active" : ""} type="button" onClick={() => setLibraryTab("history")}>版本历史 <span>{history.length}</span></button><div className="version-select"><span>当前版本</span><button type="button" onClick={() => setLibraryTab("history")}>{activeVersion}⌄</button></div></div>
      {libraryTab === "history" ? <section className="history-layout">
        <div className="version-row card"><div><span className="version-chip current">当前</span><strong>{activeVersion}</strong><small>原版本仍可回看和回滚</small></div><button className="button button-light" type="button" onClick={() => setLibraryTab("files")}>查看当前文件</button></div>
        {history.length ? history.map((item, index) => {
          const versionId = stringValue(dict(item).versionId, dict(item).version, `v${index + 1}`);
          return <div className="version-row card" key={stringValue(dict(item).id, versionId, index)}><div><span className="version-chip">{versionId}</span><strong>{stringValue(dict(item).message, dict(item).note, "中心库版本")}</strong><small>{stringValue(dict(item).createdAt, dict(item).date)}</small></div><div className="version-actions"><button className="button button-light" type="button" onClick={() => void safeAction("正在比较版本", async () => { if (!activePlanId) throw new Error("中心库尚未返回项目方案编号。"); setComparison(dict(await api.versionCompare({ planId: activePlanId, fromVersion: versionId, toVersion: activeVersion }))); })}>比较</button><button className="button button-light" type="button" data-testid={`rollback-preview-${versionId}`} onClick={() => void previewRollback(versionId)}>预览回滚</button></div></div>;
        }) : <div className="history-help card"><strong>还没有可显示的历史</strong><span>保存新草稿后会在这里留下可回滚的版本。</span></div>}
        {rollbackPreview && <section className="rollback-preview card" data-testid="rollback-preview"><header><div><p className="card-kicker">回滚预览</p><h2>从 {stringValue(rollbackPreview.sourceVersion)} 创建 {stringValue(rollbackPreview.nextVersion)} 的新版本</h2><p>当前版本 {stringValue(rollbackPreview.currentVersion)} 保持在历史中；以下是确认前的完整变更范围。</p></div><span className="status-pill warn">尚未写入</span></header><div className="rollback-summary"><strong>{numberValue(rollbackPreview.summary?.changedFiles, rollbackFiles.length)} 个文件</strong><span>新增 {numberValue(rollbackPreview.summary?.added)} · 修改 {numberValue(rollbackPreview.summary?.modified)} · 删除 {numberValue(rollbackPreview.summary?.deleted)}</span></div><div className="rollback-file-list">{rollbackFiles.length ? rollbackFiles.map((file) => <article className="diff-file" key={file.id}><header><div><span className="status-pill warn">{file.status}</span><strong>{file.path}</strong></div><span className="file-diff-count">+{file.additions} −{file.deletions}</span></header>{renderDiff(file)}</article>) : <p className="source-empty">两个版本内容相同，不会生成新的回滚版本。</p>}</div><label className="confirm-row"><input type="checkbox" checked={rollbackAcknowledged} onChange={(event) => setRollbackAcknowledged(event.target.checked)} /><span>我已查看回滚范围和逐文件差异，并确认只追加一个新版本。</span></label><div className="action-row"><button className="button button-quiet" type="button" onClick={() => { setRollbackPreview(null); setRollbackAcknowledged(false); }}>取消</button><button className="button button-dark" data-testid="confirm-rollback" type="button" disabled={!rollbackAcknowledged || !rollbackFiles.length || Boolean(busy)} onClick={() => void confirmRollback(aiInputToken)}>确认并生成回滚版本</button></div></section>}
        {comparison && normalizeFiles(comparison).length ? <section className="card diff-view"><div className="diff-summary"><strong>版本差异</strong><span>只读比较</span></div>{normalizeFiles(comparison).map((file) => <div className="diff-file" key={file.id}>{renderDiff(file)}</div>)}</section> : null}
      </section> : <div className="library-layout"><aside className="system-browser card"><label className="local-search"><span>⌕</span><input data-testid="library-search" value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder="搜索项目方案、体系、规则、来源或文件" /></label><div className="system-browser-list">{visibleSystems.length ? visibleSystems.map((item) => <div className="library-system-entry" key={item.id}><button className="library-system-button" type="button" onClick={() => { const file = visibleFiles.find((candidate) => item.filePaths?.includes(candidate.path)) || visibleFiles[0]; if (file) void openLibraryFile(file); }}><span className="library-glyph">◇</span><p><strong>{item.name}</strong><small>{item.skills} Skill · {item.rules} 规则</small></p><i>›</i></button><button className="text-button source-browse-button" type="button" onClick={() => openSource(item)}>查看来源</button></div>) : visibleFiles.length ? <div className="library-file-search-results"><p className="card-kicker">文件命中</p>{visibleFiles.map((file) => <button type="button" key={file.id} onClick={() => openFileFromSearch(file)}><strong>{file.path}</strong><small>{file.skill} · {file.status}</small></button>)}</div> : <div className="empty-workspace"><span>⌕</span><div><strong>{query ? "没有匹配内容" : "没有可显示的体系"}</strong><p>{query ? "体系、文件和右侧正文保持同一个搜索结果；可修改搜索词。" : "初始化中心库后会显示内容。"}</p></div></div>}</div><div className="plan-library-note"><span>i</span><p><strong>来源只读可查</strong><small>缓存、备份和私有项目内容不会因为搜索或保存进入中心库。</small></p></div>{librarySource && <div className="library-source card"><p className="card-kicker">来源详情</p><strong>{stringValue(librarySource.system?.name, "体系来源")}</strong><code>{stringValue(librarySource.source?.path, librarySource.source?.location)}</code><small>{stringValue(librarySource.source?.kind, "来源")}</small></div>}</aside><section className="system-detail card"><header><div><span className="detail-icon">O</span><div><h2>{active?.skill || "中心库内容"}</h2><code>{active?.path || "尚未选择文件"}</code></div></div>{active && <div><button className="button button-light" type="button" onClick={() => void createLibraryDraft("edit", active.path, "", aiInputToken)}>手动编辑</button><button className="button button-light danger-action" type="button" onClick={() => void createLibraryDraft("delete", active.path, "", aiInputToken)}>预览删除</button></div>}</header>{active ? <><div className="detail-metrics"><div><strong>{active.finalContent ? active.finalContent.split("\n").length : "—"}</strong><span>行</span></div><div><strong>{active.additions}</strong><span>新增</span></div><div><strong>{active.deletions}</strong><span>删除</span></div><div><strong>{activeVersion}</strong><span>当前版本</span></div></div><div className="file-explorer card"><aside><p className="tree-label">文件</p>{visibleFiles.map((file) => <button className={`tree-item ${file.id === active.id ? "active" : ""}`} key={file.id} type="button" onClick={() => void openLibraryFile(file)}>{file.path}</button>)}</aside><section><header><div><strong>{active.path}</strong><code>{active.status || "当前版本"}</code></div><span className="status-pill soft">只读查看</span></header><div className="code-view" data-testid="file-content"><ol>{active.finalContent.split("\n").map((line, index) => <li key={index}><code>{line || " "}</code></li>)}</ol></div><footer className="simple-safety-note">手动编辑、创建和删除都会先生成草稿，确认后保存为新版本。</footer></section></div></> : <div className="empty-workspace"><span>⌕</span><div><strong>{query ? "没有匹配文件" : "选择一个文件查看内容"}</strong><p>{query ? "搜索结果为空时不会保留上一次文件详情。" : "中心库 API 没有返回文件列表。"}</p></div></div>}</section></div>}
    </>, "library");
  };

  const renderLibraryV2 = () => {
    const sourceFiles = array(librarySource?.files).map(dict);
    const openSourceFile = (filePath: string) => void safeAction("正在读取来源正文", async () => {
      if (!activePlanId || !librarySource?.system?.id) throw new Error("当前来源没有可读取的体系编号。");
      const value = await api.librarySource({ planId: activePlanId, systemId: librarySource.system.id, filePath });
      setLibrarySource(dict(value));
    });
    return <><>{renderLibraryLegacy()}</>{librarySource && <section className="library-source-detail card" data-testid="library-source-detail"><header><div><p className="card-kicker">逐文件来源</p><h2>{stringValue(librarySource.system?.name, "体系来源")}</h2><p>来源文件只读打开，不会把来源内容写回中心库。</p></div><span className="status-pill soft">只读</span></header><div className="source-file-list">{sourceFiles.length ? sourceFiles.map((file, index) => <article className={`source-file-row ${file.path === librarySource.file?.path ? "active" : ""}`} key={stringValue(file.path, index)}><div><strong>{stringValue(file.path, file.originPath, `来源文件 ${index + 1}`)}</strong><small>{stringValue(file.originPath, file.sourcePath, "来源路径未提供")}</small><code>{stringValue(file.analysisId, "当前版本来源")}</code></div><button className="button button-light" type="button" disabled={file.contentAvailable === false || Boolean(busy)} onClick={() => openSourceFile(stringValue(file.filePath, file.originPath, file.path))}>{file.path === librarySource.file?.path ? "已打开正文" : "查看正文"}</button></article>) : <p className="source-empty">当前体系没有可浏览的来源文件。</p>}</div>{librarySource.file && <div className="source-body" data-testid="library-source-body"><div><strong>{stringValue(librarySource.file.path)}</strong><span>只读正文</span></div><pre>{stringValue(librarySource.file.content)}</pre></div>}</section>}</>;
  };

  const renderMergeV2 = () => {
    const selectedPaths = mergeSelectedFiles;
    const workspaceChanges = files.filter((file) => file.direction !== "center-only");
    const conflictCount = files.filter((file) => file.resolutionRequired).length;
    const noOpConnection = !workspaceChanges.length || Boolean(workspace?.connectionRecoveryRequired);
    if (noOpConnection && !workspaceChanges.length) return <FlowChrome activeStep={4} title="确认连接，不创建新版本" subtitle="连接工作区 · 融合预览" onCancel={cancelFlow}><section className="scope-review-banner card" role="status" data-testid="zero-diff-connection"><strong>没有新增文件，不会创建虚假版本</strong><p>{workspace?.connectionRecoveryRequired ? "历史连接状态无法完整恢复；确认后只会把当前选定范围重新标记为已连接。" : "当前版本与工作区没有文件差异；确认后只完成连接，不会新增中心库版本。"}</p></section><footer className="flow-actions sticky-actions"><button className="button button-quiet" type="button" onClick={() => navigate("connect-mode")}>返回选择</button><button className="button button-dark" data-testid="complete-connection" type="button" disabled={!selectedSystems.size || Boolean(busy)} onClick={() => void completeConnection(aiInputToken)}>完成连接 <span>→</span></button></footer></FlowChrome>;
    return <FlowChrome activeStep={4} title="逐文件看清方向，再融合进中心库" subtitle="连接工作区 · 融合预览" onCancel={cancelFlow}><section className="compare-summary card"><div><small>工作区基线</small><strong>{workspace?.baselineVersion || "连接时版本"}</strong></div><span>→</span><div><small>当前中心库</small><strong>{stringValue(comparison?.centerVersion, activeVersion)}</strong></div><div><small>工作区变化</small><strong>{workspaceChanges.length} 个文件</strong></div><div className="compare-counts"><span><b>{conflictCount}</b> 个冲突待选</span><span className="warn"><b>{selectedPaths.size}</b> 个将进入草稿</span></div></section><div className="compare-layout"><section className="update-review-main"><div className="section-heading compact"><div><h2>逐文件差异</h2><span>以连接基线为参照，中心库单边变化不会被当成工作区新增</span></div><button className="text-button" type="button" disabled={!canMutateProductInputNow()} onClick={() => setMergeSelection(selectedPaths.size === workspaceChanges.length ? new Set() : new Set(workspaceChanges.map((file) => file.path)), aiInputToken)}>{selectedPaths.size === workspaceChanges.length ? "取消全选" : "全选工作区变化"}</button></div><div className="diff-file-list">{files.length ? files.map((file) => <article className={`diff-file card ${file.direction === "center-only" ? "center-only-change" : ""}`} key={file.id}><header><label className="merge-file-select"><input data-testid="merge-file-checkbox" type="checkbox" checked={selectedPaths.has(file.path)} disabled={file.direction === "center-only" || !canMutateProductInputNow()} onChange={(event) => { const next = new Set(selectedPaths); if (event.target.checked) next.add(file.path); else next.delete(file.path); setMergeSelection(next, aiInputToken); }} /><span /></label><div><span className="status-pill warn">{file.direction === "center-only" ? "中心库单边" : file.resolutionRequired ? "两边都有修改" : file.status}</span><strong>{file.path}</strong><small>{file.direction === "center-only" ? "当前工作区没有这项变化，保留中心库版本" : file.resolutionRequired ? "请在草稿中确认保留哪一侧" : "工作区变化可进入草稿"}</small></div><span className="file-diff-count">+{file.additions} −{file.deletions}</span></header>{renderDiff(file)}</article>) : <div className="card empty-workspace"><span>✓</span><div><strong>没有工作区文件差异</strong><p>当前中心库变化已按连接基线单独标记。</p></div></div>}</div></section><aside className="update-ai-panel card"><div className="update-ai-heading"><span className="ai-avatar">✦</span><div><strong>统一交给 AI 处理</strong><small>只使用左侧勾选的文件，并生成可审阅草稿</small></div></div><textarea data-testid="merge-ai-composer" value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value, aiInputToken)} readOnly={aiComposerLocked} placeholder="例如：保留命令，只改善说明" /><button className="button button-light" type="button" disabled={!selectedPaths.size || !canMutateProductInputNow()} onClick={() => void processAi(false, new Set(files.filter((file) => selectedPaths.has(file.path)).map((file) => file.id)))}>先让 AI 生成草稿</button><div className="plan-library-note"><span>↶</span><p><strong>三方比较</strong><small>基线、中心库和工作区分别显示；未勾选的工作区变化不会进入新版本。</small></p></div><label className="version-note"><span>版本说明（可选）</span><input aria-label="版本说明" placeholder="例如：融合说明文字更新" value={mergeNote} onChange={(event) => setMergeNote(event.target.value, aiInputToken)} readOnly={!canMutateProductInputNow()} disabled={!canMutateProductInputNow()} /></label></aside></div><footer className="flow-actions sticky-actions"><button className="button button-quiet" type="button" onClick={() => navigate("connect-mode")}>返回选择</button><button className="button button-dark" data-testid="save-merge" type="button" disabled={!selectedPaths.size || !canMutateProductInputNow()} onClick={() => void createMergeDraft(aiInputToken)}>{busy || "预览并保存新版本"} <span>→</span></button></footer></FlowChrome>;
  };

  const renderError = () => error && !analysisFailure ? <div className="product-error" role="alert"><strong>这一步没有完成</strong><span>{error}</span>{errorDetails && <details className="tech-details"><summary>技术详情</summary><pre>{errorDetails}</pre></details>}<button className="button button-light" type="button" onClick={() => { setError(""); setErrorDetails(""); }}>知道了</button></div> : null;

  const renderWelcome = () => (
    <main className="onboarding-shell" aria-labelledby="welcome-title">
      <header className="brand-row"><Brand onClick={enterEmptyHome} /><span className="prototype-badge">中心库初始化</span></header>
      <section className="onboarding-grid">
        <div className="welcome-copy">
          <p className="eyebrow">第一次使用 · 第 1 步，共 4 步</p>
          <h1 id="welcome-title">先找到你的工作区，<br />其余交给我们分析。</h1>
          <p className="lead">选择一个工作区或 Git 工作树。Skill Graft 会先做只读检查，将 Skill、Agent 规则和来源整理成一个推荐项目方案。</p>
          <div className={`folder-picker ${workspace?.path ? "selected" : ""}`}>
            <div className="folder-icon" aria-hidden="true" />
            <div className="folder-copy"><strong>{workspace?.name || "还没有选择工作区"}</strong><span>{workspace?.path || "支持本地文件夹、Git 工作树"}</span></div>
            <button className="button button-primary" data-action="choose-initial" data-testid="choose-initial" type="button" onClick={() => void chooseWorkspace("initialize")}>用资源管理器选择</button>
          </div>
          <p className="prototype-hint">会调用 Windows 原生文件夹选择器；分析阶段不会写入工作区。</p>
          <div className="action-row"><button className="button button-quiet" type="button" onClick={enterEmptyHome}>稍后再说</button><button className="button button-dark" data-action="start-init-analysis" data-testid="start-init-analysis" type="button" disabled={!workspace?.path || Boolean(busy)} onClick={() => void analyzeWorkspace("initialize")}>{busy || "开始只读分析"}</button></div>
          <p className="safety-line"><span>✓</span> 分析阶段不会新增、删除或覆盖工作区里的任何文件。</p>
        </div>
        <aside className="explain-card" aria-label="初始化说明"><div className="explain-top"><span className="mini-label">你只需要做一次</span><span className="shield">✓</span></div><h2>建立第一个“项目方案”</h2><p>中心库可以保存少量不同项目方案。首次只建立一个，不会把不同项目强行混成同一套 Skill。</p><ol className="plain-steps"><li><span>1</span><div><strong>选择</strong><small>用 Windows 资源管理器选择文件夹</small></div></li><li><span>2</span><div><strong>分析</strong><small>自动区分方案内容、私有扩展和来源证据</small></div></li><li><span>3</span><div><strong>确认</strong><small>确认一个推荐项目方案</small></div></li><li><span>4</span><div><strong>创建</strong><small>保存为可比较、可回滚的方案 v1</small></div></li></ol><p className="no-jargon">不需要理解任何内部协议或运行细节。</p></aside>
      </section>
    </main>
  );

  const renderAnalysis = () => {
    const failed = analysisViewMode({ hasFailure: Boolean(analysisFailure), busy: Boolean(busy) }) === "failed";
    if (failed && analysisFailure) {
      const retryPath = normalizedAnalysisRetryPath(manualWorkspacePath || workspace?.path || "");
      return <FlowChrome activeStep={2} title="只读分析未完成" subtitle={flow === "initialize" ? "第一次使用 · 第 2 步，共 4 步" : "工作区分析 · 已停止"} onCancel={cancelFlow} update={flow === "update"}>
        <section className="analysis-failure card" data-testid="analysis-failed" role="alert"><div className="analysis-failure-heading"><span>!</span><div><p className="card-kicker">分析已停止</p><h2>没有继续扫描，也没有写入任何内容</h2><p>{analysisFailure.message}</p></div></div><label className="analysis-retry-field"><span>工作区路径</span><input data-testid="analysis-retry-path" value={manualWorkspacePath || workspace?.path || ""} onChange={(event) => setManualWorkspacePath(event.target.value)} aria-label="重试工作区路径" /></label><details className="tech-details"><summary>技术详情</summary><pre>{analysisFailure.technical}</pre></details><footer className="analysis-failure-actions"><button className="button button-quiet" type="button" onClick={() => navigate(analysisRecoveryRoute(flow) as Screen)}>返回工作区</button><button className="button button-dark" data-testid="retry-analysis" type="button" disabled={!retryPath || Boolean(busy)} onClick={() => { const nextPath = normalizedAnalysisRetryPath(manualWorkspacePath || workspace?.path || ""); if (!nextPath) { setError("请输入工作区路径后重试。"); return; } void analyzeWorkspace(flow, workspaceFrom(nextPath)); }}>{busy || "重试只读分析"} <span>→</span></button></footer></section>
      </FlowChrome>;
    }
    return <FlowChrome activeStep={2} title={flow === "update" ? "正在查看这个工作区的新变化" : "正在只读分析工作区"} subtitle={flow === "initialize" ? "第一次使用 · 第 2 步，共 4 步" : "工作区分析"} onCancel={cancelFlow} update={flow === "update"}>
      <div className="analysis-layout"><section className="analysis-visual card"><div className="scan-orbit" aria-hidden="true"><span>S</span><i /><i /><i /></div><div className="analysis-path"><small>正在分析</small><strong>{workspace?.path || "未选择工作区"}</strong></div><div className="progress-track"><span /></div><p>只读取目录、Git 索引与规则入口，结果出来前不会写入文件。</p></section><section className="check-card card"><p className="card-kicker">分析范围</p><div className="check-list"><div><span>✓</span><strong>查找 Skill、Agent 规则与清单</strong><small>已完成</small></div><div><span>✓</span><strong>核对 Git 记录与物理文件</strong><small>已完成</small></div><div><span>…</span><strong>识别链接、重复、缓存与版本关系</strong><small>正在归并</small></div></div><div className="inline-safety"><span>✓</span><p><strong>不会触碰用户改动</strong><small>不会 checkout、清理、attach 或恢复缺失文件。</small></p></div></section></div>
      <footer className="flow-actions"><button className="button button-quiet" type="button" onClick={cancelFlow}>取消分析</button><button className="button button-dark" data-action="show-analysis-results" data-testid="show-analysis-results" type="button" disabled={!analysis || Boolean(busy)} onClick={() => navigate(flow === "update" ? "update-review" : "analysis-results")}>{busy || "查看分析结果"} <span>→</span></button></footer>
    </FlowChrome>;
  };

  const renderSystemCard = (item: System) => {
    const selectable = item.selectable !== false && !item.blocked && item.decision !== "reference-only" && (item.decision !== "keep-private" || (advanced && flow !== "initialize"));
    const checked = selectedSystems.has(item.id);
    const referenceOnly = !selectable && (item.selectable === false || item.decision === "reference-only" || item.kind === "external-link");
    const decisionLabel = checked
      ? "已选择"
      : item.blocked
        ? "安全阻止"
        : item.decision === "keep-private"
          ? (selectable ? "可选择纳入" : "默认留在工作区")
          : referenceOnly
            ? "仅作证据"
            : "可选择纳入";
    return <article className={`system-card ${checked ? "selected" : ""} ${!selectable ? "reference" : ""} ${item.blocked ? "blocked" : ""}`} key={item.id}><div className="system-main"><label className="system-check"><input type="checkbox" checked={checked} disabled={!selectable} onChange={(event) => { setScopeSelectionConfirmed(true); setSelectedSystems((current) => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; }); }} /><span /></label><div className="system-copy"><div className="system-title-row"><div><h3>{item.name}</h3><p>{item.subtitle || "Skill 与规则集合"}</p></div><span className={`decision-pill ${checked ? "chosen" : ""}`}>{decisionLabel}</span></div><div className="badge-row">{item.badges.map((badge) => <span key={badge}>{badge}</span>)}</div><p className="system-explain">{item.explanation || "来源和归并关系已经保留，是否纳入由你确认。"}</p>{item.blocked && <div className="system-blocked" role="alert"><strong>{item.unavailableReason || "检测到工作区外部链接，已停止读取。"}</strong><p>{item.safeReason || "请将链接目标移入所选工作区，或改用工作区内的规范目录后重新分析。"}</p>{item.diagnosticPaths?.length ? <details className="tech-details"><summary>查看技术诊断</summary><pre>{item.diagnosticPaths.join("\n")}</pre></details> : null}</div>}<details className="source-details"><summary>查看 {item.sources.length} 个来源与归并依据</summary><div className="source-list">{item.sources.map((source) => <div key={`${source.kind}-${source.path}`}><span>{source.kind}</span><code>{source.path}</code></div>)}</div></details>{item.samplePaths?.length ? <details className="sample-path-details"><summary>查看实际展示的 {item.samplePaths.length} 个 skip-worktree 相对路径</summary><ul>{item.samplePaths.map((samplePath) => <li key={samplePath}><code>{samplePath}</code></li>)}</ul></details> : null}</div></div><div className="system-counts"><span><strong>{countLabel(item.skills, "0")}</strong> Skill</span><span><strong>{countLabel(item.rules, "0")}</strong> 规则</span><small>{item.confidence}</small></div></article>;
  };

  const renderAnalysisResults = () => (
    <FlowChrome activeStep={flow === "initialize" ? 3 : 2} title={flow === "initialize" ? "确认第一个项目方案" : "确认要连接的项目内容"} subtitle={flow === "initialize" ? "第一次使用 · 第 3 步，共 4 步" : `已完成 · ${workspace?.path || "工作区"}`} onCancel={cancelFlow} update={false}>
      <section className="result-summary card"><div><span className="success-dot">✓</span><div><strong>只读分析完成</strong><p>{workspace?.summary || "已整理 Skill、Agent 规则、链接、缓存、休眠记录和声明缺失。"}</p>{numberValue(analysis?.summary?.externalLinks) > 0 && <p className="safe-inline-warning">发现指向工作区外部的链接，已停止读取；请查看下方“安全阻止”说明并将目标移入工作区后重试。</p>}</div></div><div className="summary-facts"><span>别名不重复计数</span><span>缓存不作为来源</span><span>来源工作区保持原样</span></div></section>
      {flow !== "initialize" ? renderSelectionReview() : null}
      {renderSafetyEvidence(blockedAnalysisSystems, "检测到工作区外部链接，本次分析已安全停止读取")}
      <div className="results-toolbar"><div><strong>{systems.length || "—"} 类分析结果</strong><span>{flow === "initialize" ? "首次只确认一个推荐项目方案。" : "只保留这个已连接工作区的原有体系，不自动勾选其他体系。"}</span></div><button className="text-button" type="button" onClick={() => setAdvanced((value) => !value)}>{advanced ? "收起高级来源" : "高级：查看逐文件来源"}</button></div>
      <section className="systems-list" data-testid="analysis-results">{systems.length ? systems.map(renderSystemCard) : <div className="card empty-workspace"><span>⌕</span><div><strong>没有可确认的项目方案</strong><p>分析没有返回可纳入的内容，请返回工作区重新分析。</p></div><button className="button button-light" type="button" onClick={() => void analyzeWorkspace(flow)}>重新分析</button></div>}</section>
      {advanced && <div className="card plan-library-note"><span>i</span><p><strong>逐文件来源</strong><small>展开每个来源时仍保持只读。缓存、PackageCache、休眠条目和声明未落盘内容只作为证据，不会自动写入中心库。</small></p></div>}
      <aside className="protection-banner"><span>保护边界</span><p>休眠记录、未落盘声明、缓存与项目私有 Skill 不会被自动纳入、删除、覆盖或上传。</p><strong>{selectedSystems.size} 组内容将进入下一步</strong></aside>
      <footer className="flow-actions sticky-actions"><button className="button button-quiet" type="button" onClick={cancelFlow}>取消，什么都不做</button><button className="button button-dark" type="button" disabled={!selectedSystems.size || Boolean(busy) || selectionReviewPending || blockedAnalysisSystems.length > 0} data-testid={flow === "initialize" ? "preview-v1" : "choose-connect-mode"} onClick={() => flow === "initialize" ? navigate("init-preview") : navigate("connect-mode")}>{flow === "initialize" ? "预览项目方案 v1" : selectionReviewPending ? "请确认连接范围" : "继续：选择如何连接"} <span>→</span></button></footer>
    </FlowChrome>
  );

  const renderInitPreview = () => {
    const chosen = systems.filter((item) => selectedSystems.has(item.id));
    const totalSkills = chosen.reduce((sum, item) => sum + item.skills, 0);
    const totalRules = chosen.reduce((sum, item) => sum + item.rules, 0);
    return <FlowChrome activeStep={4} title="一眼确认，再创建第一个方案" subtitle="第一次使用 · 第 4 步，共 4 步" onCancel={cancelFlow}><div className="preview-grid"><section className="preview-main card"><div className="version-hero"><span>即将创建</span><strong>{overview?.libraryName || "项目方案"} v1</strong><p>这是一个新的、可比较且可回滚的方案起点。</p></div><div className="preview-metrics"><div><strong>1</strong><span>项目方案</span></div><div><strong>{totalSkills}</strong><span>Skill</span></div><div><strong>{totalRules}</strong><span>Agent 规则</span></div></div><h3>纳入范围</h3><div className="compact-system-list">{chosen.map((item) => <div key={item.id}><span className="mini-system-icon">{item.name.slice(0, 1)}</span><p><strong>{item.name}</strong><small>{item.confidence}</small></p><span>已选择</span></div>)}</div></section><aside className="boundary-card card"><p className="card-kicker">创建前确认</p><h2>只写入中心库数据区</h2><div className="boundary-list"><div><span>✓</span><p><strong>来源工作区保持原样</strong><small>{workspace?.path}</small></p></div><div><span>✓</span><p><strong>不纳入缓存与缺失记录</strong><small>它们仍作为分析证据保留</small></p></div><div><span>✓</span><p><strong>以后每次修改都生成新版本</strong><small>v1 永远可以查看和比较</small></p></div></div><label className="confirm-row"><input type="checkbox" checked={initAcknowledged} onChange={(event) => setInitAcknowledged(event.target.checked)} /><span>我已查看纳入范围和保全边界</span></label></aside></div><footer className="flow-actions"><button className="button button-quiet" type="button" onClick={() => navigate("analysis-results")}>返回调整</button><button className="button button-dark" data-action="create-v1" data-testid="create-v1" type="button" disabled={!initAcknowledged || Boolean(busy)} onClick={() => void initializeLibrary(aiInputToken)}>{busy || "创建项目方案 v1"} <span>→</span></button></footer></FlowChrome>;
  };

  const renderInitSuccess = () => <main className="success-shell"><div className="success-card"><div className="success-mark">✓</div><p className="eyebrow">初始化完成</p><h1>{overview?.libraryName || "项目方案"} v1 已创建</h1><p>中心库现在包含第一个项目方案。来源工作区没有被修改。</p><div className="success-version"><span>v1</span><div><strong>{overview?.libraryName || "项目方案"}</strong><small>{countLabel(overview?.skillCount, "—")} 个 Skill</small></div><time>刚刚</time></div><div className="success-actions"><button className="button button-light" type="button" onClick={() => navigate("library")}>查看中心库</button><button className="button button-primary" data-testid="enter-home" type="button" onClick={() => navigate("home")}>进入工作区首页 →</button></div></div></main>;

   const shell = (content: React.ReactNode, active: "home" | "library" | "workspaces" | "assistant" | "diagnostics") => <div className="app-shell"><aside className="sidebar"><Brand onClick={() => navigate("home")} /><nav aria-label="主导航"><button className={active === "home" ? "active" : ""} type="button" onClick={() => navigate("home")}><span>⌂</span>首页{overviewChanges.length ? <i className="nav-dot" /> : null}</button><button className={active === "library" ? "active" : ""} type="button" onClick={() => navigate("library")}><span>▦</span>中心库</button><button className={active === "workspaces" ? "active" : ""} type="button" onClick={() => navigate("workspaces")}><span>◇</span>工作区{overviewChanges.length ? <i className="nav-dot" /> : null}</button><button className={active === "assistant" ? "active" : ""} type="button" onClick={() => navigate("assistant")}><span>✦</span>AI 助手</button></nav><div className="sidebar-bottom"><button type="button" onClick={() => navigate("diagnostics")}><span>⚙</span>设置与诊断</button><div className="profile-chip"><span>OZ</span><p><strong>本机中心库</strong><small>仅此设备</small></p><i>⌄</i></div></div></aside><main className="workspace-main"><header className="topbar"><button className="mobile-menu" type="button" aria-label="打开导航" onClick={() => navigate("home")}>☰</button><div className="global-search"><span>⌕</span><input aria-label="全局搜索" value={globalSearch} onChange={(event) => setGlobalSearch(event.target.value)} placeholder="搜索项目方案、Skill、规则、来源或文件" /><kbd>Ctrl K</kbd>{globalSearch.trim() && <div className="global-search-results" role="listbox">{globalSearchResults.length ? globalSearchResults.map((result) => <button key={stringValue(result.id, result.title)} type="button" onClick={() => { setGlobalSearch(""); if (result.type === "workspace") { setWorkspace(workspaceFrom(result.path)); navigate("workspaces"); } else { setLibrarySearch(stringValue(result.title)); navigate("library"); } }}><strong>{stringValue(result.title, "未命名结果")}</strong><small>{stringValue(result.detail, result.type)}</small></button>) : <span>没有找到匹配的项目方案、体系、规则、来源或文件</span>}</div>}</div><button className="top-icon" type="button" aria-label="帮助" onClick={() => navigate("diagnostics")}>?</button><button className="top-icon has-dot" type="button" aria-label="通知" onClick={() => overviewChanges.length ? openPendingUpdate() : void checkConnectedWorkspace()}>○</button></header><div className="page-wrap">{content}</div></main></div>;

  const openPendingUpdate = useCallback(() => {
    const firstChange = overviewChanges[0];
    const next = workspaceFrom(first(firstChange?.workspace, firstChange?.worktree, firstChange?.path));
    if (!next.path) {
      setError("没有找到待处理工作区，请先重新检查。");
      return;
    }
    openWorkspaceUpdate(next);
  }, [openWorkspaceUpdate, overviewChanges]);

  const renderHome = () => {
    const count = first(overview?.skillCount, libraryFiles.filter((file) => /(?:^|\/)SKILL\.md$/i.test(file.path)).length || undefined);
     return shell(<><header className="page-title home-heading"><div><p className="eyebrow">工作区首页</p><h1>上午好，中心库一切清晰。</h1><p>从这里处理新修改、查看已连接工作树，或直接和 AI 对话。</p></div><div className="page-actions"><button className="button button-dark" type="button" onClick={() => navigate("connect-select")}>＋ 连接工作区</button></div></header><div className="dashboard-grid"><section className={`home-update-card card ${workspaceRecheck.pending ? "is-busy" : overviewChanges.length ? "has-update" : "is-clear"}`} data-testid="home-update-card" aria-busy={workspaceRecheck.ariaBusy}><div className="home-update-icon">{workspaceRecheck.pending ? "…" : overviewChanges.length ? "↗" : "✓"}</div><div className="home-update-copy"><span className="home-card-label">当前修改</span><h2>{workspaceRecheck.heading}</h2><p>{workspaceRecheck.detail}</p></div><div className="home-update-actions">{workspaceRecheck.pending ? <button className="button button-light" data-testid="home-trigger-update" type="button" aria-busy={workspaceRecheck.ariaBusy} disabled onClick={() => void checkConnectedWorkspace()}>{workspaceRecheck.actionLabel}</button> : overviewChanges.length ? <><button className="button button-primary" data-testid="home-view-update" type="button" onClick={openPendingUpdate}>查看新修改</button><button className="text-button" data-testid="home-trigger-update" type="button" disabled={Boolean(busy)} onClick={() => void checkConnectedWorkspace()}>{workspaceRecheck.actionLabel}</button></> : <button className="button button-light" data-testid="home-trigger-update" type="button" disabled={Boolean(busy)} onClick={() => void checkConnectedWorkspace()}>{workspaceRecheck.actionLabel}</button>}</div></section><section className="card home-skill-count"><span className="home-card-label">中心库</span><strong>{countLabel(count)}</strong><h2>个 Skill</h2><p>{countLabel(overview?.planCount, "—")} 个项目方案可分别管理。</p><button className="button button-light" type="button" onClick={() => navigate("library")}>打开中心库 →</button></section></div><section className="section-block"><div className="section-heading"><div><p className="eyebrow">工作区</p><h2>已连接工作树</h2></div><button className="text-button" type="button" onClick={() => navigate("workspaces")}>查看全部 →</button></div><div className="workspace-list card">{worktrees.length ? worktrees.map((tree) => <button className="workspace-row" type="button" key={tree.path} onClick={() => { setWorkspace(tree); navigate("workspaces"); }}><span className="workspace-avatar">{tree.name.slice(0, 2).toUpperCase()}</span><div><strong>{tree.name}</strong><code>{tree.path}</code></div><span className={`status-pill ${tree.hasChanges || tree.safetyBlocked || tree.selectionNeedsReview || tree.connectionRecoveryRequired ? "warn" : "ok"}`}>{workspaceCardStatus(tree)}</span><span>→</span></button>) : <div className="empty-workspace"><span>◇</span><div><strong>还没有已连接工作树</strong><p>连接一个工作区后，它会出现在这里。</p></div><button className="button button-light" type="button" onClick={() => navigate("connect-select")}>连接工作区</button></div>}</div></section><section className="home-ai-card card"><div className="home-shortcut-icon">✦</div><div><p className="home-card-label">快速开始</p><h2>和 AI 一起整理中心库</h2><p>描述你想修改的 Skill 或规则，AI 会先给出可预览草稿。</p></div><form className="home-ai-form" data-testid="home-ai-form" onSubmit={(event) => void sendChat(event, true)}><input data-testid="home-chat-input" aria-label="快速开始 AI 对话" placeholder="例如：把安装说明改得更容易读" value={chatDraft} readOnly={!canEditChatInput()} disabled={!canEditChatInput()} onChange={(event) => setChatDraftFromUser(event.target.value, chatInputToken)} /><button className="send-button" data-testid="home-ai-submit" type="submit" disabled={!chatDraft.trim() || !canEditChatInput()}>→</button></form><button className="text-button" type="button" onClick={() => navigate("assistant")}>打开完整对话 →</button></section><div className="principles-strip"><div><span>◎</span><p><strong>先分析</strong><small>选择路径后不写文件</small></p></div><div><span>▣</span><p><strong>先预览</strong><small>每次写入前看清变化</small></p></div><div><span>↶</span><p><strong>可恢复</strong><small>版本和保全点都不删除历史</small></p></div></div></>, "home");
  };

  const renderConnectSelect = () => <FlowChrome activeStep={1} title="连接一个新的工作区" subtitle="连接工作区 · 第 1 步" onCancel={cancelFlow}><div className="connect-select-grid"><section className="connect-picker card"><div className="big-folder"><i /></div><p className="card-kicker">先选择，再分析</p><h2>{workspace?.name || "还没有选择工作区"}</h2><code>{workspace?.path || "Windows 原生资源管理器"}</code><p>连接前会先只读分析这个工作区的 Skill、规则、别名、重复内容和私有扩展。</p><button className="button button-primary" type="button" onClick={() => void chooseWorkspace("connect")}>用资源管理器选择</button><small>不会 attach、清理或覆盖工作区</small></section><aside className="connect-promises"><h3>连接前你会看到</h3><div><span>1</span><p><strong>有哪些项目方案</strong><small>不同项目不必强行合成一套</small></p></div><div><span>2</span><p><strong>哪些内容真的发生变化</strong><small>别名和缓存不会重复计算</small></p></div><div><span>3</span><p><strong>两种清晰选择</strong><small>融合进中心库，或使用中心库接管</small></p></div></aside></div><footer className="flow-actions"><button className="button button-quiet" type="button" onClick={cancelFlow}>取消</button><button className="button button-dark" data-testid="start-connect-analysis" type="button" disabled={!workspace?.path || Boolean(busy)} onClick={() => void analyzeWorkspace("connect")}>{busy || "开始只读分析"} <span>→</span></button></footer></FlowChrome>;

  const renderConnectMode = () => <FlowChrome activeStep={3} title="你希望怎样连接这个工作区？" subtitle="连接工作区 · 已完成分析" onCancel={cancelFlow}><div className="mode-intro card"><span className="success-dot">✓</span><div><strong>{workspace?.name || "工作区"} 已完成只读分析</strong><p>接下来只决定中心库与工作区的关系，不会自动修改私有内容。</p></div></div><div className="mode-grid"><button className="mode-card recommended" data-testid="choose-merge" type="button" onClick={() => void compareWorkspace("merge")}><span className="mode-icon">↗</span><span className="recommend-chip">推荐</span><h2>融合进中心库</h2><p>把新内容与中心库比较，解决冲突后生成一个新的中心库版本。</p><ul><li>保留来源和差异记录</li><li>冲突逐项确认</li><li>不覆盖项目私有 Skill</li></ul><strong>查看比较结果 <i>→</i></strong></button><button className="mode-card" data-testid="choose-takeover" type="button" onClick={() => void previewTakeover()}><span className="mode-icon">↓</span><h2>使用中心库接管</h2><p>预览将改动什么，再把中心库内容应用到这个工作区。</p><ul><li>先显示替换范围</li><li>保全本地私有内容</li><li>支持回滚接管</li></ul><strong>生成接管预览 <i>→</i></strong></button></div><button className="advanced-link" type="button" onClick={() => setAdvanced((value) => !value)}>高级：逐体系选择 <span>{advanced ? "⌃" : "⌄"}</span></button>{advanced && <div className="card plan-library-note"><span>i</span><p><strong>高级选择</strong><small>已在上一步列出体系；默认流程只需要做一次整体决策。当前已选择 {selectedSystems.size} 组内容。</small></p></div>}</FlowChrome>;

  const renderMerge = () => {
    const compareFiles = files;
    return <FlowChrome activeStep={4} title="先看清差异，再融合进中心库" subtitle="连接工作区 · 融合预览" onCancel={cancelFlow}><section className="compare-summary card"><div><small>来源工作区</small><strong>{workspace?.name || "工作区"}</strong></div><span>→</span><div><small>目标</small><strong>{overview?.libraryName || "中心库"}</strong></div><div className="compare-counts"><span><b>{compareFiles.length}</b> 个文件</span><span className="warn"><b>{compareFiles.filter((file) => file.status !== "新增").length}</b> 个需确认</span></div></section><div className="compare-layout"><section><div className="section-heading compact"><h2>文件差异</h2><span className="resolved-chip">只读比较</span></div><div className="change-table card"><div className="change-head"><span>文件</span><span>变化</span><span>状态</span></div>{compareFiles.length ? compareFiles.map((file) => <div key={file.id}><p><strong>{file.path}</strong><code>{file.skill}</code></p><span className="diff-add">+{file.additions} / −{file.deletions}</span><span>{file.status}</span></div>) : <div><p><strong>没有返回文件差异</strong><code>服务未提供比较内容</code></p><span>—</span><span>请重试</span></div>}</div></section><aside className="merge-receipt card"><p className="card-kicker">融合边界</p><h2>将生成新的中心库版本</h2><div className="receipt-list"><div><span>✓</span><p><strong>来源工作区保持原样</strong><small>{workspace?.path}</small></p></div><div><span>✓</span><p><strong>私有内容不会自动覆盖</strong><small>需要明确选择才会进入草稿</small></p></div><div><span>✓</span><p><strong>历史版本继续保留</strong><small>取消不会产生版本</small></p></div></div><label className="version-note"><span>版本说明（可选）</span><input aria-label="版本说明" placeholder="例如：融合 Unity MCP 更新" value={mergeNote} onChange={(event) => setMergeNote(event.target.value)} /></label></aside></div><footer className="flow-actions sticky-actions"><button className="button button-quiet" type="button" onClick={() => navigate("connect-mode")}>返回选择</button><button className="button button-dark" data-testid="save-merge" type="button" disabled={!compareFiles.length || Boolean(busy)} onClick={() => void createMergeDraft(aiInputToken)}>{busy || "预览并保存新版本"} <span>→</span></button></footer></FlowChrome>;
  };

  const renderMergeSuccess = () => { const receipt = dict(overview?.mergeReceipt || mergeReceiptRef.current); const receiptWorkspace = workspace?.name || (receipt.workspacePath ? workspaceFrom(receipt.workspacePath).name : "工作区"); const receiptFileCount = numberValue(receipt.fileCount, files.length); return <main className="merge-complete-shell"><div className="merge-complete-hero"><div className="success-mark">✓</div><p className="eyebrow">融合完成</p><h1>新的中心库版本已保存</h1><p>{receiptWorkspace} 的选定内容已经进入中心库，来源工作区没有被覆盖。</p></div><div className="merge-result-grid"><section className="merge-receipt card"><p className="card-kicker">本次结果</p><h2>{overview?.libraryName || "中心库"}</h2><div className="receipt-stats"><div><strong>{receiptFileCount}</strong><span>文件</span></div><div><strong>{stringValue(receipt.versionId, "新版本")}</strong><span>已生成</span></div><div><strong>可回滚</strong><span>历史保留</span></div></div><div className="merge-complete-boundary"><span>✓</span><p><strong>工作区保持原样</strong><small>如需让其他工作区使用中心库，可单独选择接管。</small></p></div></section></div><div className="merge-complete-actions"><button className="button button-light" type="button" onClick={() => navigate("library")}>查看中心库</button><button className="button button-dark" data-testid="finish-merge" type="button" onClick={() => navigate("home")}>回到首页 →</button></div></main>; };

  const changeCard = (item: any) => { const row = dict(item); return <article className="skill-change-card" key={stringValue(row.id, row.path, row.name)}><div className="skill-change-icon">✦</div><div className="skill-change-summary"><strong>{stringValue(row.name, row.skillName, row.skill, row.path, "未命名 Skill")}</strong><p>{stringValue(row.summary, row.description, row.reason, "检测到来自已连接工作树的新修改。")}</p><span>{stringValue(row.path, row.workspacePath, row.worktreePath)}</span></div><span className="status-pill warn">有修改</span></article>; };

  const renderUpdateReview = () => <FlowChrome activeStep={updateReviewStep} update title={updateReviewStep > 1 ? "重新分析已完成，查看结果" : "先查看工作区有哪些新修改"} subtitle={`工作区更新 · 第 ${updateReviewStep} 步，共 3 步`} onCancel={cancelFlow}><section className="update-hero card"><div className="update-hero-icon">↗</div><div><p className="card-kicker">{updateReviewStep > 1 ? "检查完成" : "只读发现"}</p><h2>{workspace?.name || "已连接工作区"} 的更新检查结果</h2><p>{blockedAnalysisSystems.length ? "本次检查发现安全阻止项，不能把未读取内容误判为“无变化”。" : updateReviewStep > 1 && !files.length ? "本次检查已完成，没有新增差异；不会创建空版本。" : "这里只列出实际发生变化的 Skill 和大概内容。下一步再逐文件比较。"}</p></div><span className="update-hero-version">尚未写入</span></section>{blockedAnalysisSystems.length ? renderSafetyEvidence(blockedAnalysisSystems, "重新分析发现工作区外部链接，已安全停止读取") : null}{workspace?.selectionNeedsReview ? renderSelectionReview() : null}<div className="simple-update-summary"><strong>{blockedAnalysisSystems.length ? "无法安全判定变化" : updateReviewStep > 1 && !changedSkills.length ? "没有新增 Skill 修改" : `${changedSkills.length || "—"} 个 Skill 有修改`}</strong><span>不会在此页合并或覆盖文件</span></div><section className="skill-change-list" data-testid="update-review">{blockedAnalysisSystems.length ? <div className="card empty-workspace safety-empty"><span>!</span><div><strong>未读取内容不能显示为“无变化”</strong><p>请先处理上方安全阻止项，再重新分析；当前没有生成比较或写入。</p></div><button className="button button-light" type="button" disabled={Boolean(busy)} onClick={() => workspace && void analyzeWorkspace("update", workspace)}>重新分析</button></div> : changedSkills.length ? changedSkills.map(changeCard) : <div className="card empty-workspace"><span>✓</span><div><strong>没有可显示的新 Skill 修改</strong><p>{busy ? "正在读取并比较实际文件，请稍候。" : updateReviewStep > 1 ? "检查已完成，当前版本与工作区一致。" : "这次检查没有发现与中心库不同的文件。"}</p></div><button className="button button-light" type="button" disabled={Boolean(busy)} onClick={() => workspace && void analyzeWorkspace("update", workspace)}>重新分析</button></div>}</section><footer className="flow-actions sticky-actions"><button className="button button-quiet" type="button" onClick={cancelFlow}>稍后处理</button>{updateReviewStep > 1 && !files.length && !blockedAnalysisSystems.length && !selectionReviewPending ? <button className="button button-dark" data-testid="complete-update-check" type="button" disabled={Boolean(busy)} onClick={() => void completeUpdateCheck()}>{busy || "完成检查"} <span>→</span></button> : <button className="button button-dark" data-testid="start-update-compare" type="button" disabled={Boolean(busy) || !files.length || blockedAnalysisSystems.length > 0 || selectionReviewPending} onClick={() => navigate("update-compare")}>{busy || (blockedAnalysisSystems.length ? "先处理安全阻止项" : selectionReviewPending ? "请确认连接范围" : "查看文件差异")} <span>→</span></button>}</footer></FlowChrome>;

  const renderDiff = (file: ChangeFile) => {
    const lines = (file.diff || file.finalContent).split("\n");
    return <div className="github-diff">{lines.map((line, index) => { const isAdd = line.startsWith("+") && !line.startsWith("+++"); const isRemove = line.startsWith("-") && !line.startsWith("---"); return <div className={`github-diff-line ${isAdd ? "changed" : isRemove ? "diff-remove" : ""}`} key={`${file.id}-${index}`}><span>{index + 1}</span><b>{isAdd ? "+" : isRemove ? "−" : " "}</b><code>{line.replace(/^[+-]/, "")}</code></div>; })}</div>;
  };

  const renderUpdateCompare = () => {
    const aiEditableFiles = files.filter(isAiEditableFile);
    const selectedAiCount = aiEditableFiles.filter((file) => aiFiles.has(file.id)).length;
    return <FlowChrome activeStep={2} update title="处理每个文件的差异" subtitle="工作区更新 · 第 2 步，共 3 步" onCancel={cancelFlow}>
      <section className="simple-update-summary card"><div><strong>{files.length} 个文件发生变化</strong><span>像查看 GitHub 提交一样逐文件检查</span></div><span className="status-pill blue">尚未写入</span></section>
      <div className="compare-layout">
        <section className="update-review-main"><div className="section-heading compact"><h2>逐文件差异</h2><span>新增 <b>{files.reduce((sum, file) => sum + file.additions, 0)}</b> · 删除 <b>{files.reduce((sum, file) => sum + file.deletions, 0)}</b></span></div><div className="diff-file-list">{files.length ? files.map((file) => <article className="diff-file card" key={file.id}><header><div><span className="status-pill warn">{file.status}</span><strong>{file.path}</strong><small>{file.skill}</small></div><span className="file-diff-count">+{file.additions} −{file.deletions}</span></header>{renderDiff(file)}</article>) : <div className="card empty-workspace"><span>⌕</span><div><strong>没有文件差异</strong><p>服务没有返回可处理的文件。</p></div></div>}</div></section>
        <aside className="update-ai-panel card"><div className="update-ai-heading"><span className="ai-avatar">✦</span><div><strong>让 AI 帮你处理</strong><small>统一说明，生成可编辑草稿</small></div></div><textarea data-testid="ai-composer" value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value, aiInputToken)} readOnly={aiComposerLocked} placeholder="告诉 AI 如何处理这些文件" /><div className="result-ai-scope"><div className="result-ai-scope-actions"><strong>交给 AI 的文件 <span className="ai-file-count">{selectedAiCount}/{aiEditableFiles.length}</span></strong><button className="text-button" type="button" disabled={!canMutateProductInputNow()} onClick={() => setScopedAiFiles(selectedAiCount === aiEditableFiles.length ? [] : aiEditableFileIds(aiEditableFiles))}>{selectedAiCount === aiEditableFiles.length ? "取消全选" : "全选"}</button></div><div className="result-ai-file-list">{files.map((file) => { const editable = isAiEditableFile(file); const selected = editable && aiFiles.has(file.id); return <label className={selected ? "result-ai-file-option selected" : "result-ai-file-option"} title={file.path} aria-label={`选择 ${file.path}`} key={file.id}><input data-testid="ai-file-checkbox" type="checkbox" checked={selected} disabled={!editable || !canMutateProductInputNow()} onChange={(event) => { const next = new Set(aiFiles); if (event.target.checked) next.add(file.id); else next.delete(file.id); setScopedAiFiles(next); }} /><span>{selected ? "✓" : ""}</span><div><strong>{file.path}</strong><small>{file.deleted ? "删除标记会转人工确认" : file.status}</small></div></label>; })}</div></div><div className="action-row ai-action-row"><button className="button button-dark result-ai-submit" data-testid="process-update-ai" type="button" disabled={!selectedAiCount || !canMutateProductInputNow()} onClick={() => void processAi(false)}>{busy || "处理并进入审阅"} <span>→</span></button>{aiCancelVisible ? <button className="button button-light" type="button" onClick={() => void cancelAi()}>取消 AI 处理</button> : null}</div><p className="simple-safety-note">AI 只生成草稿，不会直接合并；删除文件即使 AI 没有正文，也会进入人工成果页确认。</p></aside>
      </div>
      <footer className="flow-actions"><button className="button button-quiet" type="button" onClick={() => navigate("update-review")}>返回修改概览</button><button className="button button-light" data-testid="manual-review-update" type="button" disabled={!files.length || !canMutateProductInputNow()} onClick={() => void createMergeDraft(aiInputToken)}>直接进入人工审阅</button><button className="button button-dark" type="button" disabled={!selectedAiCount || !canMutateProductInputNow()} onClick={() => void processAi(false)}>处理并审阅 <span>→</span></button></footer>
    </FlowChrome>;
  };

  const renderEditableFile = (file: ChangeFile) => {
    const inputToken = aiInputToken;
    const canEditFile = () => {
      if (inputToken !== aiRequestGateRef.current.inputToken()) return false;
      return canMutateProductInputNow();
    };
    const content = currentEditorContent(file, inputToken);
    const changed = changedLineNumbers(file, content);
    const deletionBodyAvailable = !file.deleted || file.originalContentAvailable !== false;
    const pendingSave = editorIntentQueueRef.current.pendingSave(file.id, inputToken);
    const centerOnlyDraft = isLibraryDraftOrigin(stringValue(draftRef.current?.origin, draft?.origin));
    return <article className={`result-file card ${confirmedFiles.has(file.id) ? "confirmed" : ""}`} key={file.id}>
      <header>
        <div><span className="status-pill warn" data-testid="change-status">{confirmedFiles.has(file.id) ? "已确认" : file.deleted ? "待删除确认" : file.resolutionRequired ? "待解决冲突" : "待确认"}</span><strong>{file.path}</strong><small>{file.skill} · {file.deleted ? centerOnlyDraft ? "中心库删除预览" : "工作区删除" : file.direction === "center-only" ? "中心库单边变化" : file.status}</small></div>
        <div className="result-file-actions"><button className={`button ${confirmedFiles.has(file.id) ? "button-light" : "button-dark"}`} type="button" disabled={!deletionBodyAvailable || (!canMutateProductInputNow() && !pendingSave)} onPointerDown={(event) => { preserveConfirmClickOnPointerDown(event); }} onClick={() => void confirmFile(file.id, aiInputToken)}>{confirmedFiles.has(file.id) ? "取消确认" : deletionBodyAvailable ? "确认此文件" : "正文不可用，已阻止保存"}</button></div>
      </header>
      <div className="result-inline-editor" data-testid="file-content">
        {file.deleted ? <div className="deletion-tombstone"><strong>结构化删除标记</strong><p>{file.aiSkipped ? "AI 未返回文件正文，已保留删除标记；现在由人工确认删除。" : centerOnlyDraft ? "这是中心库中的待删除文件；确认后只会从下一版本移除，不会修改任何工作区。" : "此文件在工作区中已不存在；删除不会依赖 AI 返回正文。"}</p><pre>{deletionBodyAvailable ? file.originalContent : "（原文件正文不可用，已阻止保存）"}</pre><small>{deletionBodyAvailable ? "确认后仅从下一版本移除，历史版本仍保留原正文。" : "当前版本正文无法读取，未允许盲目保存删除。请重新读取当前版本后重试。"}</small></div> : <><div className="result-editor-highlights" aria-hidden="true"><div className="result-editor-highlight-lines">{content.split("\n").map((_, index) => <span className={changed.has(index + 1) ? "changed" : ""} key={index} />)}</div></div><div className="result-editor-gutter-viewport"><div className="result-editor-gutter">{content.split("\n").map((_, index) => <span className={changed.has(index + 1) ? "changed" : ""} key={index}><i>{index + 1}</i><b>{changed.has(index + 1) ? "+" : ""}</b></span>)}</div></div><textarea
          className="inline-result-editor"
          data-testid="file-editor"
          aria-label={`${file.path} 最终内容`}
          value={content}
          readOnly={!canEditFile()}
          onChange={(event) => {
            if (!canEditFile()) return;
            const nextContent = event.target.value;
            // Editing a previously confirmed file starts a new review intent;
            // a later blur must be allowed to persist the new body and the
            // file will need confirmation again.
            editorIntentQueueRef.current.releaseConfirmation(file.id, inputToken);
            if (confirmedFilesRef.current.has(file.id)) {
              const nextConfirmed = new Set(confirmedFilesRef.current);
              nextConfirmed.delete(file.id);
              confirmedFilesRef.current = nextConfirmed;
              setConfirmedFiles(nextConfirmed);
            }
            rememberEditorSnapshot(file.id, file.path, nextContent, inputToken);
            filesRef.current = filesRef.current.map((item) => item.id === file.id ? { ...item, finalContent: nextContent } : item);
            setFiles((current) => current.map((item) => item.id === file.id ? { ...item, finalContent: nextContent } : item));
          }}
          onScroll={(event) => {
            const container = event.currentTarget.parentElement;
            const offset = `translateY(-${event.currentTarget.scrollTop}px)`;
            const highlights = container?.querySelector<HTMLElement>(".result-editor-highlight-lines");
            const gutter = container?.querySelector<HTMLElement>(".result-editor-gutter");
            if (highlights) highlights.style.transform = offset;
            if (gutter) gutter.style.transform = offset;
          }}
          onBlur={(event) => {
            if (canEditFile()) {
              const nextContent = event.target.value;
              rememberEditorSnapshot(file.id, file.path, nextContent, inputToken);
              void editorIntentQueueRef.current.queueSave(file.id, inputToken, () => saveFile(file.id, nextContent, inputToken));
            }
          }}
        /></>}
      </div>
      <p className="inline-edit-hint">{file.deleted ? deletionBodyAvailable ? centerOnlyDraft ? "这是中心库删除 tombstone；确认后只生成中心库新版本。" : "这是可审阅的删除 tombstone；确认按钮决定是否从新版本移除。" : "删除正文不可用，已 fail closed；当前不能确认或保存。" : "可直接编辑；绿色行是本次修改。离开编辑框时自动保存草稿。"}</p>
    </article>;
  };

  const renderUpdateResult = () => {
    const presentation = resolveDraftSavePresentation({ transaction: saveTransaction, draftOrigin: stringValue(draft?.origin), flow, busy });
    const origin = presentation.origin;
    const presentationFlow = presentation.flow;
    const presentationBusy = presentation.busy || busy;
    const aiEditableFiles = files.filter(isAiEditableFile);
    const selectedAiCount = aiEditableFiles.filter((file) => aiFiles.has(file.id)).length;
    const allConfirmed = files.length > 0 && files.every((file) => confirmedFiles.has(file.id));
    const title = origin === "library-create" ? "预览新建文件，再保存版本" : origin === "library-delete" ? "预览删除文件，再保存版本" : origin === "library-manual-edit" ? "审阅中心库编辑，再保存版本" : "审阅最终结果，再确认合并";
    const subtitle = origin.startsWith("library-") ? "中心库编辑 · 预览与保存" : presentationFlow === "connect" ? "工作区融合 · 第 3 步，共 3 步" : "工作区更新 · 第 3 步，共 3 步";
    return <FlowChrome activeStep={3} update editable variant={origin.startsWith("library-") ? "center" : undefined} title={title} subtitle={subtitle} onCancel={cancelFlow}>
      <section className="result-overview card"><div><span className="success-dot">✦</span><div><strong>{origin === "library-create" ? "新建文件草稿已准备" : origin === "library-delete" ? "删除文件草稿已准备" : origin === "library-manual-edit" ? "中心库手动编辑草稿已准备" : presentationFlow === "connect" ? "融合草稿已准备" : "可编辑草稿已准备"}</strong><p>{origin.startsWith("library-") ? "这是基于当前中心库版本的编辑草稿；保存会生成新的中心库版本，原版本保持可回滚。" : "每个文件都可以直接点击、上下滚动和编辑；绿色背景表示本次新增或修改。"}</p></div></div><span className="result-progress">{confirmedFiles.size}/{files.length}<small>文件已确认</small></span></section>
      <section className="result-ai-composer card"><div className="result-ai-heading"><span className="ai-avatar">✦</span><div><strong>继续让 AI 修改</strong><small>勾选文件后输入一次统一要求</small></div></div><div className="result-ai-composer-row"><textarea data-testid="ai-composer" value={resultPrompt} onChange={(event) => setResultPrompt(event.target.value, aiInputToken)} readOnly={aiComposerLocked} placeholder="例如：保留命令，只把说明改成新同事能看懂的步骤" /><button className="button button-dark" data-testid="ai-submit" type="button" disabled={!aiEditableFiles.length || !canMutateProductInputNow()} onClick={() => void processAi(true)}>{presentationBusy || "让 AI 修改"}</button>{aiCancelVisible ? <button className="button button-light" type="button" onClick={() => void cancelAi()}>取消 AI 处理</button> : null}</div><div className="result-ai-scope-actions"><strong>选择文件 <span className="ai-file-count">{selectedAiCount}/{aiEditableFiles.length}</span></strong><button className="text-button" type="button" disabled={!canMutateProductInputNow()} onClick={() => setScopedAiFiles(selectedAiCount === aiEditableFiles.length ? [] : aiEditableFileIds(aiEditableFiles))}>{selectedAiCount === aiEditableFiles.length ? "取消全选" : "全选"}</button></div><div className="result-ai-file-list">{files.map((file) => { const editable = isAiEditableFile(file); const selected = editable && aiFiles.has(file.id); return <label className={selected ? "result-ai-file-option selected" : "result-ai-file-option"} key={file.id}><input data-testid="ai-file-checkbox" type="checkbox" checked={selected} disabled={!editable || !canMutateProductInputNow()} onChange={(event) => { const next = new Set(aiFiles); if (event.target.checked) next.add(file.id); else next.delete(file.id); setScopedAiFiles(next); }} /><span>{selected ? "✓" : ""}</span><div><strong>{file.path}</strong><small>{file.deleted ? "待删除确认（仅人工）" : file.confirmed ? "已确认" : file.resolutionRequired ? "待解决冲突" : "待确认"}</small></div></label>; })}</div></section>
      <section className="result-files" data-testid="file-content">{files.length ? files.map(renderEditableFile) : <div className="card empty-workspace"><span>⌕</span><div><strong>没有可审阅的文件</strong><p>请返回差异页重新获取草稿。</p></div><button className="button button-light" type="button" onClick={() => navigate("update-compare")}>返回差异</button></div>}</section>
      <footer className="result-sticky-actions sticky-actions"><div><strong>{confirmedFiles.size}/{files.length}</strong><span>{allConfirmed ? "所有文件已确认" : "请审阅并确认每个文件"}</span></div><button className="button button-dark" data-testid="confirm-update-merge" type="button" disabled={!allConfirmed || !canMutateProductInputNow()} onClick={() => void commitUpdate(aiInputToken)}>{presentationBusy || "保存新的中心库版本"} <span>→</span></button></footer>
    </FlowChrome>;
  };

  const renderUpdateSuccess = () => {
    const receipt = dict(overview?.productReceipt || overview?.commitReceipt || overview?.mergeReceipt || mergeReceiptRef.current);
    // The draft/transaction origin is local context for a just-completed
    // action; a refreshed result page has no draft state, so its durable
    // receipt becomes authoritative. Do not let a stale workspace origin turn
    // a center-only save into “更新已合并/原工作区”.
    const presentation = draftSaveSuccessPresentation({ origin: stringValue(draft?.origin, saveTransaction?.origin, receipt.origin), receipt, fileCount: files.length });
    return <main className="merge-complete-shell">
      <div className="merge-complete-hero">
        <div className="success-mark">✓</div>
        <p className="eyebrow">{presentation.eyebrow}</p>
        <h1>{presentation.title}</h1>
        <p>{presentation.subtitle}</p>
      </div>
      <div className="merge-result-grid">
        <section className="merge-receipt card">
          <p className="card-kicker">已处理</p>
          <h2>{presentation.fileCount} 个文件</h2>
          <div className="receipt-list">
            <div><span>✓</span><p><strong>{presentation.centerOnly ? "中心库编辑已确认" : "每个文件都经过确认"}</strong><small>{presentation.centerOnly ? "最终内容已经作为新的中心库版本保存。" : "最终内容已经作为新版本保存。"}</small></p></div>
            <div><span>↶</span><p><strong>可以回滚</strong><small>{presentation.centerOnly ? "从中心库历史查看并恢复原版本。" : "从中心库历史查看并恢复。"}</small></p></div>
          </div>
        </section>
      </div>
      <div className="merge-complete-actions"><button className="button button-light" type="button" onClick={() => navigate("library")}>查看中心库</button><button className="button button-dark" type="button" onClick={() => navigate("home")}>回到首页 →</button></div>
    </main>;
  };

  const renderTakeover = () => renderTakeoverV2();

  const renderTakeoverSuccess = () => {
    const rollbackId = stringValue(comparison?.protectionId, workspace?.protectionId);
    const checking = takeoverStatusChecking || takeoverStatus === "checking";
    const alreadyRolledBack = takeoverStatus === "rolled-back";
    const statusUnknown = takeoverStatus === "unknown";
    const canRollback = takeoverStatus === "active" && !checking && Boolean(rollbackId);
    const eyebrow = checking ? "正在核对接管状态" : alreadyRolledBack ? "接管已回滚" : statusUnknown ? "接管状态未知" : "接管完成";
    const heading = checking
      ? "正在确认这次接管是否仍然生效"
      : alreadyRolledBack
        ? "这次接管已经回滚"
        : statusUnknown
          ? "无法确认这次接管的当前状态"
          : (workspace?.name || "工作区") + " 已使用中心库";
    const detail = checking
      ? "正在读取工作区的权威状态；核对完成前不会允许回滚。"
      : alreadyRolledBack
        ? "已读取当前工作区状态；旧的接管成功页不能再次写入。"
        : statusUnknown
          ? "当前没有足够的权威信息确认接管是否仍然生效；为安全起见已禁用回滚，请返回首页后重试。"
          : "应用范围已按预览执行，项目私有内容和原有保全边界仍然保留。";
    return <main className="merge-complete-shell"><div className="merge-complete-hero"><div className="success-mark">✓</div><p className="eyebrow">{eyebrow}</p><h1>{heading}</h1><p>{detail}</p></div><div className="merge-complete-actions"><button className="button button-light" data-testid="rollback-takeover" type="button" disabled={!canRollback} onClick={() => void rollbackTakeover(aiInputToken)}>{checking ? "正在核对接管状态" : alreadyRolledBack ? "这次接管已回滚" : statusUnknown ? "无法确认状态" : "回滚这次接管"}</button><button className="button button-dark" type="button" onClick={() => navigate("home")}>回到首页 →</button></div></main>;
  };

  const renderWorkspaces = () => shell(<><header className="page-title"><div><p className="eyebrow">工作区</p><h1>已连接与待连接</h1><p>每个工作区先分析，再决定融合或接管。</p></div><div className="page-actions"><button className="button button-dark" type="button" onClick={() => navigate("connect-select")}>＋ 连接工作区</button></div></header><section className="workspace-cards">{worktrees.length ? worktrees.map((tree) => <article className="workspace-card card" key={tree.path}><div className="workspace-meta"><span className="workspace-avatar">{tree.name.slice(0, 2).toUpperCase()}</span><div><strong>{tree.name}</strong><code>{tree.path}</code></div><span className={`status-pill ${tree.hasChanges || tree.safetyBlocked || tree.selectionNeedsReview || tree.connectionRecoveryRequired ? "warn" : "ok"}`}>{workspaceCardStatus(tree)}</span></div><p>{tree.safetyBlocked ? "重新分析发现安全阻止项；先处理外部链接，再比较变化。" : tree.connectionRecoveryRequired ? "历史连接信息需要明确完成连接；不会创建虚假版本。" : tree.hasChanges ? "工作区有新的 Skill 修改，可以进入发现变化流程。" : "重新分析只检查这个已连接体系，不会重新选择多个体系。"}</p><div className="version-actions"><button className="button button-light" type="button" onClick={() => openWorkspaceUpdate(tree)}>重新分析变化</button></div></article>) : <div className="empty-workspace card"><span>◇</span><div><strong>还没有已连接工作树</strong><p>选择一个工作区开始分析。</p></div><button className="button button-dark" type="button" onClick={() => navigate("connect-select")}>连接工作区</button></div>}</section></>, "workspaces");

  const renderAssistant = () => shell(<><header className="page-title"><div><p className="eyebrow">AI 助手</p><h1>把想法说清楚，先看草稿。</h1><p>这是正常的对话页面。技术状态只在下方详情里显示。</p></div><div className="page-actions"><button className="button button-light" type="button" onClick={startNewChat}>新对话</button></div></header><section className="assistant-page"><div className="chat-panel card"><div className="chat-scroll">{chatMessages.length ? chatMessages.map((message, index) => <div className={`chat-row ${message.role}`} key={`${message.role}-${index}`}><span className={`avatar ${message.role === "assistant" ? "ai-avatar" : "user-avatar"}`}>{message.role === "assistant" ? "✦" : "我"}</span><div className="bubble"><p>{message.body}</p>{message.proposal && <span className="proposal-card">可预览修改范围</span>}</div></div>) : <div className="empty-workspace"><span>✦</span><div><strong>从一个问题开始</strong><p>例如：请检查 Unity MCP 的安装说明，并告诉我哪些文件适合一起修改。</p></div></div>}</div><form className="composer" data-testid="chat-form" onSubmit={(event) => void sendChat(event)}><textarea data-testid="chat-input" aria-label="AI 对话输入" value={chatDraft} readOnly={!canEditChatInput()} disabled={!canEditChatInput()} onChange={(event) => setChatDraftFromUser(event.target.value, chatInputToken)} placeholder="告诉 AI 你想查看或修改什么" /><button className="button button-dark" type="submit" disabled={!chatDraft.trim() || !canEditChatInput() || Boolean(busy)}>{busy || "发送"} <span>→</span></button></form></div><aside className="conversation-list card"><p className="card-kicker">本次对话</p><h2>{conversationId ? "已连接" : "新的对话"}</h2><p>AI 的修改会先形成草稿，进入比较和审阅后才会写入中心库。</p><details className="tech-details"><summary>技术详情</summary><code>{conversationId || "尚未建立会话"}</code><button className="button button-light" type="button" disabled={!conversationId} onClick={() => void refreshConversation()}>刷新状态</button></details></aside></section></>, "assistant");

  const renderDiagnostics = () => shell(<><header className="page-title"><div><p className="eyebrow">高级诊断</p><h1>只在需要时查看技术详情。</h1><p>这里不参与主流程；可用于确认服务是否可访问和保全边界。</p></div></header><div className="diagnostic-grid"><section className="diagnostic-card card"><strong>产品 API</strong><span>主流程通过 product API 读取和写入。</span><button className="button button-light" type="button" onClick={() => void safeAction("正在检查中心库", async () => { await refreshOverview(); })}>重新检查中心库</button></section><section className="diagnostic-card card"><strong>当前操作</strong><span>{busy || "没有正在执行的写入"}</span><button className="button button-light" type="button" onClick={() => { setError(""); setErrorDetails(""); }}>清除提示</button></section></div><details className="tech-details card"><summary>显示原始响应摘要</summary><pre>{JSON.stringify({ initialized: overview?.initialized, changes: overviewChanges.length, worktrees: worktrees.length }, null, 2)}</pre></details></>, "diagnostics");

  const renderRecovery = () => <main className="success-shell"><div className="success-card"><div className="recovery-icon">!</div><p className="eyebrow">操作未完成</p><h1>当前没有应用任何变更</h1><p>{error || "服务暂时不可用，或者操作被取消。你可以安全重试；工作区和中心库都保持原样。"}</p><div className="success-actions"><button className="button button-light" type="button" onClick={() => void refreshOverview().then(() => navigate(overview?.initialized ? "home" : "welcome")).catch((caught) => { const formatted = formatProductError(caught); setError(formatted.message); setErrorDetails(formatted.technical); })}>重试</button><button className="button button-primary" type="button" onClick={() => navigate("home")}>返回首页</button></div></div></main>;

  let content: React.ReactNode;
  if (loading && !overview) content = <main className="success-shell"><div className="success-card"><div className="scan-orbit"><span>S</span></div><p>正在读取中心库…</p></div></main>;
  else if (screen === "welcome") content = renderWelcome();
  else if (screen === "analysis") content = renderAnalysis();
  else if (screen === "analysis-results") content = renderAnalysisResults();
  else if (screen === "init-preview") content = renderInitPreview();
  else if (screen === "init-success") content = renderInitSuccess();
  else if (screen === "home") content = renderHome();
  else if (screen === "connect-select") content = renderConnectSelect();
  else if (screen === "connect-mode") content = renderConnectMode();
  else if (screen === "merge") content = renderMergeV2();
  else if (screen === "merge-success") content = renderMergeSuccess();
  else if (screen === "update-review") content = renderUpdateReview();
  else if (screen === "update-compare") content = renderUpdateCompare();
  else if (screen === "update-result") content = renderUpdateResult();
  else if (screen === "update-success") content = renderUpdateSuccess();
  else if (screen === "takeover") content = renderTakeoverV2();
  else if (screen === "takeover-success") content = renderTakeoverSuccess();
  else if (screen === "library") content = renderLibraryV2();
  else if (screen === "workspaces") content = renderWorkspaces();
  else if (screen === "assistant") content = renderAssistant();
  else if (screen === "diagnostics") content = renderDiagnostics();
  else content = renderRecovery();

  const pathFallback = (screen === "welcome" || screen === "connect-select") ? <details className="manual-path-fallback" open={manualPathOpen} onToggle={(event) => setManualPathOpen((event.currentTarget as HTMLDetailsElement).open)}><summary>文件夹选择器未显示？</summary><div><label htmlFor="manual-workspace-path">手动输入工作区路径</label><input id="manual-workspace-path" data-testid="manual-workspace-path" value={manualWorkspacePath} onChange={(event) => setManualWorkspacePath(event.target.value)} placeholder="例如 E:\\ozdqp-skill-hub" /><button className="button button-light" data-testid="use-manual-workspace" type="button" onClick={applyManualWorkspacePath}>使用这个路径</button><small>这是兼容性后备入口；默认仍使用 Windows 原生文件夹选择器。</small></div></details> : null;
  return <>{content}{pathFallback}{renderError()}</>;
}
