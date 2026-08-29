"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPanelApi } from "../../lib/api.mjs";

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
type Workspace = {
  path: string;
  name: string;
  summary?: string;
  status?: string;
  version?: string;
  hasChanges?: boolean;
  pendingAnalysisId?: string;
  pendingComparisonId?: string;
  planId?: string;
};
type System = {
  id: string;
  name: string;
  subtitle: string;
  decision: string;
  confidence: string;
  skills: number;
  rules: number;
  badges: string[];
  explanation: string;
  sources: Array<{ kind: string; path: string }>;
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
};
type ChatMessage = { role: "user" | "assistant"; body: string; proposal?: boolean };

const api = createPanelApi().productApi;

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

function countLabel(value: unknown, fallback = "—"): string {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function basename(path: string): string {
  const parts = path.replaceAll("/", "\\").split("\\").filter(Boolean);
  return parts[parts.length - 1] || "未命名工作区";
}

function errorMessage(error: unknown): string {
  return stringValue(dict(error).message, error) || "请求未完成，请重试。";
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

function workspaceFrom(value: unknown): Workspace {
  if (typeof value === "string") return { path: value, name: basename(value) };
  const source = dict(value);
  const path = stringValue(source.path, source.workspacePath, source.worktreePath, source.root);
  return {
    path,
    name: stringValue(source.name, path ? basename(path) : "未命名工作区"),
    summary: workspaceSummary(first(source.summary, source.pendingSummary, source.description)),
    status: stringValue(source.status, source.state),
    version: stringValue(source.version, source.currentVersion),
    hasChanges: Boolean(first(source.hasChanges, source.hasUpdates, source.pendingChanges, source.updateCount, source.updatesCount)),
    pendingAnalysisId: stringValue(source.pendingAnalysisId),
    pendingComparisonId: stringValue(source.pendingComparisonId),
    planId: stringValue(source.planId),
  };
}

function normalizeOverview(value: unknown): Dict {
  const raw = dict(value);
  const library = dict(first(raw.library, raw.centralLibrary, raw.centerLibrary));
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
    const inferredSkills = new Set(fileRows
      .map((file) => stringValue(file.path, file.name))
      .filter((path) => /(?:^|\/)SKILL\.md$/i.test(path))).size;
    const inferredRules = fileRows
      .map((file) => stringValue(file.path, file.name))
      .filter((path) => /(?:AGENTS|CLAUDE)(?:\.|$)/i.test(path)).length;
    return {
      id,
      name: stringValue(row.name, row.title, id),
      subtitle: stringValue(row.subtitle, row.description, row.summary),
      decision: status,
      confidence: stringValue(row.confidence, row.confidenceLabel, "待确认"),
      skills: numberValue(row.skills, row.skillCount, row.fileCount && inferredSkills, inferredSkills),
      rules: numberValue(row.rules, row.ruleCount, row.counts && dict(row.counts).rules, inferredRules),
      badges: array(first(row.badges, row.labels, row.tags)).map(String),
      explanation: stringValue(row.explanation, row.reason, row.note),
      sources,
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
      contentLoaded: file.contentLoaded || record.contentLoaded,
      confirmed: record.confirmed ?? file.confirmed,
      editable: record.editable ?? file.editable,
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

function pathFor(screen: Screen): string {
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
  return mapping[screen];
}

function screenForPath(pathname: string): Screen {
  const path = pathname || "/";
  if (path === "/" || path === "") return "home";
  if (path.startsWith("/setup/analysis")) return "analysis";
  if (path.startsWith("/setup/results")) return "analysis-results";
  if (path.startsWith("/setup/preview")) return "init-preview";
  if (path.startsWith("/setup/success")) return "init-success";
  if (path.startsWith("/setup")) return "welcome";
  if (path.startsWith("/changes/compare")) return "update-compare";
  if (path.startsWith("/changes/result")) return "update-result";
  if (path.startsWith("/changes/success")) return "update-success";
  if (path.startsWith("/changes")) return "update-review";
  if (path.startsWith("/workspaces/connect/merge")) return "merge";
  if (path.startsWith("/workspaces/connect/merged")) return "merge-success";
  if (path.startsWith("/workspaces/connect/takeover")) return "takeover";
  if (path.startsWith("/workspaces/connect/taken-over")) return "takeover-success";
  if (path.startsWith("/workspaces/connect/mode")) return "connect-mode";
  if (path.startsWith("/workspaces/connect")) return "connect-select";
  if (path.startsWith("/workspaces")) return "workspaces";
  if (path.startsWith("/library")) return "library";
  if (path.startsWith("/assistant")) return "assistant";
  if (path.startsWith("/diagnostics")) return "diagnostics";
  if (path.startsWith("/recovery")) return "recovery";
  return "home";
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

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

async function readChatStatusWithRetry(sessionId: string): Promise<Dict> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return dict(await api.chatStatus(sessionId));
    } catch (caught) {
      lastError = caught;
      if (!isTransientChatStatusError(caught) || attempt === 4) throw caught;
      await waitFor(1000);
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

function WizardSteps({ active, update = false }: { active: number; update?: boolean }) {
  const labels = update ? ["查看 Skill 修改", "处理文件差异", "审阅最终结果"] : ["选择工作区", "只读分析", "确认项目方案", "创建方案"];
  return (
    <ol className={`wizard-steps ${update ? "update-steps" : ""}`} aria-label={update ? "更新处理进度" : "初始化进度"}>
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
  editable = false,
  onCancel,
}: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
  activeStep: number;
  update?: boolean;
  editable?: boolean;
  onCancel: () => void;
}) {
  return (
    <main className="flow-shell">
      <header className="flow-header">
        <div className="flow-brand"><Brand compact onClick={onCancel} /><span className="context-chip">Skill Graft</span></div>
        <button className="icon-button close-button" type="button" onClick={onCancel} aria-label="取消并退出">×</button>
      </header>
      <div className="flow-progress"><WizardSteps active={activeStep} update={update} /></div>
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
  const [analysis, setAnalysis] = useState<Dict | null>(null);
  const [systems, setSystems] = useState<System[]>([]);
  const [selectedSystems, setSelectedSystems] = useState<Set<string>>(new Set());
  const [library, setLibrary] = useState<Dict | null>(null);
  const [libraryTab, setLibraryTab] = useState<"systems" | "files" | "history">("systems");
  const [librarySearch, setLibrarySearch] = useState("");
  const [activeFile, setActiveFile] = useState<ChangeFile | null>(null);
  const [comparison, setComparison] = useState<Dict | null>(null);
  const [draft, setDraft] = useState<Dict | null>(null);
  const [files, setFiles] = useState<ChangeFile[]>([]);
  const [aiFiles, setAiFiles] = useState<Set<string>>(new Set());
  const [aiPrompt, setAiPrompt] = useState("保留命令、路径和安全边界，只改善说明和重复表述。");
  const [resultPrompt, setResultPrompt] = useState("让文字更清楚，但不要改变命令、路径和安全边界。");
  const [mergeNote, setMergeNote] = useState("");
  const [confirmedFiles, setConfirmedFiles] = useState<Set<string>>(new Set());
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [confirmDirtyTakeover, setConfirmDirtyTakeover] = useState(false);

  const navigate = useCallback((next: Screen, replace = false) => {
    if (typeof window !== "undefined") {
      const href = pathFor(next);
      if (replace) window.history.replaceState({}, "", href);
      else window.history.pushState({}, "", href);
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    }
    setScreen(next);
    setError("");
  }, []);

  const refreshOverview = useCallback(async () => {
    let value = await api.overview();
    const mapped = normalizeOverview(value);
    const connected = array(mapped.worktrees).map(workspaceFrom).filter((tree) => tree.path && tree.planId);
    if (connected.length) {
      await Promise.all(connected.map((tree) => api.workspaceCheck({ workspacePath: tree.path, worktreePath: tree.path }).catch(() => null)));
      value = await api.overview();
    }
    setOverview(normalizeOverview(value));
    return value;
  }, []);

  const safeAction = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const value = await refreshOverview();
        if (!alive) return;
        const mapped = normalizeOverview(value);
        if (mapped.initialized) {
          void api.library().then((libraryValue: unknown) => {
            if (alive) setLibrary(dict(libraryValue));
          }).catch(() => {});
        }
        const route = screenForPath(window.location.pathname);
        if (window.location.pathname === "/" && !mapped.initialized) setScreen("welcome");
        else setScreen(route);
      } catch (caught) {
        if (alive) {
          setError(errorMessage(caught));
          setScreen("recovery");
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const onPopState = () => setScreen(screenForPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => {
      alive = false;
      window.removeEventListener("popstate", onPopState);
    };
  }, [refreshOverview]);

  useEffect(() => {
    if (screen !== "library") return;
    let alive = true;
    void api.library().then((value: unknown) => {
      if (alive) setLibrary(dict(value));
    }).catch((caught: unknown) => {
      if (alive) setError(errorMessage(caught));
    });
    return () => { alive = false; };
  }, [screen]);

  const overviewChanges = useMemo(() => array(overview?.changes), [overview]);
  const worktrees = useMemo(() => array(overview?.worktrees).map(workspaceFrom), [overview]);
  const librarySystems = useMemo(() => normalizeSystems(library || {}), [library]);
  const libraryFiles = useMemo(() => normalizeFiles(library || {}), [library]);
  const history = useMemo(() => array(first(library?.history, library?.versions, library?.versionHistory, library?.plan?.versions)), [library]);
  const changedSkills = useMemo(() => summarizeChangedSkills(files), [files]);
  const filteredSystems = useMemo(() => {
    const query = librarySearch.trim().toLowerCase();
    if (!query) return librarySystems;
    return librarySystems.filter((item) => `${item.name} ${item.subtitle} ${item.id}`.toLowerCase().includes(query));
  }, [librarySearch, librarySystems]);
  const activePlan = array(overview?.plans).map(dict).find((plan) => stringValue(plan.planId, plan.id) === stringValue(overview?.activePlanId)) || dict(overview?.plan);
  const activePlanId = stringValue(overview?.activePlanId, overview?.planId, overview?.library?.planId, activePlan.planId, analysis?.planId, analysis?.projectPlanId);
  const activeVersion = stringValue(overview?.currentVersion, overview?.library?.currentVersion, overview?.version, activePlan.currentVersion, "v1");

  const openLibraryFile = useCallback(async (file: ChangeFile) => {
    setActiveFile(file);
    if (!activePlanId) return;
    await safeAction("正在读取文件", async () => {
      const value = await api.libraryFile({ planId: activePlanId, version: activeVersion, path: file.path });
      const raw = dict(value);
      if (raw.content === undefined) throw new Error("中心库没有返回文件正文。");
      setActiveFile({ ...file, finalContent: String(raw.content), originalContent: String(raw.content) });
    });
  }, [activePlanId, activeVersion, safeAction]);

  useEffect(() => {
    if (screen === "library" && !activeFile && libraryFiles[0]) void openLibraryFile(libraryFiles[0]);
  }, [activeFile, libraryFiles, openLibraryFile, screen]);

  useEffect(() => {
    const draftId = payloadId(draft);
    if (screen !== "update-result" || !draftId || !files.length) return;
    let cancelled = false;
    const loadDraftFiles = async () => {
      try {
        const draftValue = dict(await api.draft(draftId));
        if (!cancelled) {
          setDraft(draftValue);
          const records = normalizeFiles(draftValue);
          if (records.length) setFiles((current) => mergeDraftFiles(current, records));
        }
      } catch {
        // A draft can still be displayed from the comparison response while
        // the server is catching up; the per-file reads below remain useful.
      }
      const loaded = await Promise.all(files.map(async (file) => {
        try {
          const value = dict(await api.libraryFile({ draftId, path: file.path }));
          return value.content === undefined ? null : { path: file.path, content: String(value.content) };
        } catch {
          return null;
        }
      }));
      if (cancelled) return;
      setFiles((current) => current.map((file) => {
        const value = loaded.find((item) => item?.path === file.path);
        return value ? { ...file, finalContent: value.content } : file;
      }));
    };
    void loadDraftFiles();
    return () => { cancelled = true; };
  }, [files.length, payloadId(draft), screen]);

  const chooseWorkspace = useCallback(async (purpose: "initialize" | "connect") => {
    await safeAction("正在打开资源管理器", async () => {
      const value = await api.pickFolder({ purpose });
      const raw = dict(value);
      if (raw.cancelled || raw.canceled) return;
      const picked = workspaceFrom(value);
      if (!picked.path) throw new Error("没有收到所选工作区路径，当前没有任何写入。");
      setWorkspace(picked);
    });
  }, [safeAction]);

  const applyManualWorkspacePath = useCallback(() => {
    const path = manualWorkspacePath.trim();
    if (!path) return setError("请输入工作区绝对路径。");
    setWorkspace(workspaceFrom(path));
    setError("");
  }, [manualWorkspacePath]);

  const analyzeWorkspace = useCallback(async (mode: Flow, targetWorkspace?: Workspace) => {
    const target = targetWorkspace || workspace;
    if (!target?.path) {
      setError("请先选择一个工作区。");
      return;
    }
    setWorkspace(target);
    setFlow(mode);
    setAnalysis(null);
    setSystems([]);
    setFiles([]);
    setComparison(null);
    navigate("analysis");
    await safeAction("正在只读分析", async () => {
      const value = await api.analyze({ workspacePath: target.path, path: target.path, mode, purpose: mode });
      const raw = dict(value);
      setAnalysis(raw);
      const nextSystems = normalizeSystems(value);
      setSystems(nextSystems);
      const recommended = nextSystems.filter((item) => item.decision !== "reference-only" && item.decision !== "keep-private").map((item) => item.id);
      const chosen = recommended.length
        ? (mode === "initialize" ? recommended.slice(0, 1) : recommended)
        : nextSystems.slice(0, mode === "initialize" ? 1 : nextSystems.length).map((item) => item.id);
      setSelectedSystems(new Set(chosen));
      if (mode === "update") {
        if (!activePlanId) throw new Error("中心库尚未返回项目方案编号，无法比较更新。");
        const compared = dict(await api.compare({
          workspacePath: target.path,
          path: target.path,
          mode,
          analysisId: stringValue(raw.id, raw.analysisId),
          selectedSystems: chosen,
          includePrivate: chosen.some((id) => nextSystems.find((item) => item.id === id)?.decision === "keep-private"),
          planId: activePlanId,
        }));
        const nextFiles = normalizeFiles(compared);
        setComparison(compared);
        setFiles(nextFiles);
        setAiFiles(new Set(nextFiles.map((item) => item.id)));
        navigate("update-review");
      }
    });
  }, [activePlanId, navigate, safeAction, workspace]);

  const openWorkspaceUpdate = useCallback((target: Workspace) => {
    void analyzeWorkspace("update", target);
  }, [analyzeWorkspace]);

  const checkConnectedWorkspace = useCallback(async () => {
    const target = workspace?.path || worktrees[0]?.path;
    if (!target) {
      await refreshOverview();
      return;
    }
    await safeAction("正在检查工作区修改", async () => {
      await api.workspaceCheck({ worktreePath: target, workspacePath: target, path: target });
      await refreshOverview();
    });
  }, [refreshOverview, safeAction, workspace?.path, worktrees]);

  const initializeLibrary = useCallback(async () => {
    if (!workspace?.path) return setError("没有可初始化的工作区。");
    await safeAction("正在创建中心库 v1", async () => {
      const value = await api.initializeLibrary({ workspacePath: workspace.path, path: workspace.path, analysisId: stringValue(analysis?.id, analysis?.analysisId), selectedSystems: [...selectedSystems], systemIds: [...selectedSystems], planId: stringValue(analysis?.planId, analysis?.projectPlanId) });
      setLibrary(dict(value));
      await refreshOverview();
      navigate("init-success", true);
    });
  }, [analysis, navigate, refreshOverview, safeAction, selectedSystems, workspace]);

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
        const recommended = nextSystems
          .filter((item) => item.decision !== "reference-only" && item.decision !== "keep-private")
          .map((item) => item.id);
        activeSelectedSystems = recommended.length ? recommended : nextSystems.map((item) => item.id);
        setSelectedSystems(new Set(activeSelectedSystems));
      }
      const value = await api.compare({ workspacePath: workspace.path, path: workspace.path, mode, analysisId: stringValue(activeAnalysis?.id, activeAnalysis?.analysisId), selectedSystems: activeSelectedSystems, includePrivate: activeSelectedSystems.some((id) => systems.find((item) => item.id === id)?.decision === "keep-private"), planId: activePlanId });
      const raw = dict(value);
      const nextFiles = normalizeFiles(value);
      setComparison(raw);
      setFiles(nextFiles);
      setAiFiles(new Set(nextFiles.map((item) => item.id)));
      const returnedDraft = dict(first(raw.draft, raw.result));
      if (Object.keys(returnedDraft).length) setDraft(returnedDraft);
      navigate(mode === "update" ? "update-compare" : "merge");
    });
  }, [activePlanId, analysis, navigate, safeAction, selectedSystems, systems, workspace]);

  const createMergeDraft = useCallback(async () => {
    if (!workspace?.path) return setError("没有可融合的工作区。");
    await safeAction("正在生成融合草稿", async () => {
      const value = await api.libraryDraft({ comparisonId: stringValue(comparison?.id, comparison?.comparisonId), planId: activePlanId, selectedSystems: [...selectedSystems] });
      const id = payloadId(value);
      if (!id) throw new Error("服务器没有返回融合草稿编号，未创建任何版本。");
      setDraft(dict(value));
      const returnedFiles = normalizeFiles(value);
      // A draft is only a safe staging point. Do not confirm or commit here:
      // merge and update must share the same final, editable review page.
      if (!files.length && returnedFiles.length) setFiles(returnedFiles);
      setAiFiles(new Set((files.length ? files : returnedFiles).map((file) => file.id)));
      setConfirmedFiles(new Set());
      setFlow("connect");
      navigate("update-result");
    });
  }, [activePlanId, comparison, files, navigate, safeAction, selectedSystems, workspace]);

  const processAi = useCallback(async (fromResult = false) => {
    const prompt = (fromResult ? resultPrompt : aiPrompt).trim();
    if (!prompt) return setError("请告诉 AI 你希望如何处理这些文件。");
    const selected = [...aiFiles];
    if (!selected.length) return setError("请至少勾选一个要交给 AI 的文件。");
    await safeAction("正在生成 AI 草稿", async () => {
      let activeDraft = draft;
      let id = payloadId(activeDraft);
      const comparisonId = stringValue(comparison?.comparisonId, comparison?.id);
      if (!id) {
        if (!comparisonId) throw new Error("没有比较编号，无法创建编辑草稿。");
        activeDraft = dict(await api.libraryDraft({ comparisonId, planId: activePlanId }));
        id = payloadId(activeDraft);
        if (!id) throw new Error("服务器没有返回草稿编号，当前没有写入。");
        setDraft(activeDraft);
      }
      const selectedPaths = selected.map((fileId) => files.find((file) => file.id === fileId)?.path || fileId).filter(Boolean);
      const value = dict(await api.draftAi({ draftId: id, message: prompt, selectedFiles: selectedPaths, comparisonId, workspacePath: workspace?.path }));
      const session = dict(first(value.session, value));
      const sessionId = stringValue(value.chatId, value.sessionId, session.id);
      if (!sessionId) throw new Error("AI 没有返回处理会话，当前没有读取旧草稿。");
      {
        setConversationId(sessionId);
        let status = await readChatStatusWithRetry(sessionId);
        let completed = ["completed", "succeeded"].includes(stringValue(status.session?.status, status.status).toLowerCase());
        for (let attempt = 0; attempt < 120 && !completed && !["failed", "cancelled", "canceled"].includes(stringValue(status.session?.status, status.status).toLowerCase()); attempt += 1) {
          await waitFor(1000);
          status = await readChatStatusWithRetry(sessionId);
          completed = ["completed", "succeeded"].includes(stringValue(status.session?.status, status.status).toLowerCase());
        }
        const statusValue = stringValue(status.session?.status, status.status).toLowerCase();
        if (["failed", "cancelled", "canceled"].includes(statusValue)) throw new Error(stringValue(status.session?.error, "AI 处理未完成"));
        if (!completed) throw new Error("AI 仍在处理，当前没有读取旧草稿。请稍后重试或查看助手状态。");
      }
      const fetchedFiles = await Promise.all(selectedPaths.map(async (path) => ({ path, value: dict(await api.libraryFile({ draftId: id, path })) })));
      const currentFiles = files.length ? files : normalizeFiles(activeDraft);
      setFiles(currentFiles.map((file) => {
        const fetched = fetchedFiles.find((item) => item.path === file.path)?.value;
        return fetched && fetched.content !== undefined ? { ...file, finalContent: String(fetched.content) } : file;
      }));
      setDraft(activeDraft);
      setConfirmedFiles(new Set());
      navigate("update-result");
    });
  }, [activePlanId, aiFiles, aiPrompt, comparison, draft, files, navigate, resultPrompt, safeAction, workspace]);

  const saveFile = useCallback(async (fileId: string, content: string) => {
    setDraft((current) => current ? { ...current, files: array(current.files).map((item) => dict(item).id === fileId || dict(item).fileId === fileId ? { ...dict(item), content, finalContent: content } : item) } : current);
    try {
      const value = await api.draftFile({ draftId: payloadId(draft), fileId, path: files.find((item) => item.id === fileId)?.path, content, finalContent: content });
      const returnedFiles = normalizeFiles(value);
      if (returnedFiles.length) setFiles((current) => mergeDraftFiles(current, returnedFiles));
      setError("");
    } catch (caught) {
      setError(`${errorMessage(caught)} 草稿仍保留在当前页面，尚未合并。`);
    }
  }, [draft, files]);

  const confirmFile = useCallback(async (fileId: string) => {
    const next = !confirmedFiles.has(fileId);
    await safeAction(next ? "正在确认文件" : "正在撤销确认", async () => {
      const file = files.find((item) => item.id === fileId);
      if (!file) throw new Error("没有找到要确认的文件。");
      if (next) {
        await api.draftFile({ draftId: payloadId(draft), fileId, path: file.path, content: file.finalContent, finalContent: file.finalContent });
      }
      await api.draftConfirm({ draftId: payloadId(draft), fileId, path: file.path, confirmed: next });
      setConfirmedFiles((current) => {
        const copy = new Set(current);
        if (next) copy.add(fileId); else copy.delete(fileId);
        return copy;
      });
    });
  }, [confirmedFiles, draft, files, safeAction]);

  const commitUpdate = useCallback(async () => {
    if (!draft && !comparison) return setError("没有可提交的草稿。");
    if (files.length && confirmedFiles.size !== files.length) return setError("请先确认每个有修改的文件，或逐个检查后再合并。");
    await safeAction("正在合并回中心库", async () => {
      const value = await api.draftCommit({ draftId: payloadId(draft), comparisonId: stringValue(comparison?.id, comparison?.comparisonId), workspacePath: workspace?.path, confirmedFileIds: [...confirmedFiles], message: flow === "connect" ? mergeNote.trim() : "融合工作区发现的新修改" });
      setDraft(dict(value));
      await refreshOverview();
      navigate(flow === "connect" ? "merge-success" : "update-success", true);
    });
  }, [comparison, confirmedFiles, draft, files.length, flow, mergeNote, navigate, refreshOverview, safeAction, workspace]);

  const previewTakeover = useCallback(async () => {
    if (!workspace?.path) return setError("请先选择工作区。");
    await safeAction("正在生成接管预览", async () => {
      if (!activePlanId) throw new Error("中心库尚未返回项目方案编号，无法生成接管预览。");
      const value = await api.takeoverPreview({ planId: activePlanId, versionId: activeVersion, worktreePath: workspace.path, workspacePath: workspace.path });
      setComparison(dict(value));
      setConfirmDirtyTakeover(false);
      navigate("takeover");
    });
  }, [activePlanId, activeVersion, navigate, safeAction, workspace]);

  const applyTakeover = useCallback(async () => {
    if (!workspace?.path) return setError("没有可接管的工作区。");
    await safeAction("正在应用中心库", async () => {
      const value = await api.takeoverApply({ previewId: stringValue(comparison?.id, comparison?.previewId), planHash: stringValue(comparison?.planHash), confirmDirty: confirmDirtyTakeover });
      setComparison(dict(value));
      await refreshOverview();
      navigate("takeover-success", true);
    });
  }, [comparison, confirmDirtyTakeover, navigate, refreshOverview, safeAction, workspace]);

  const readChatStatus = useCallback((sessionId: string) => readChatStatusWithRetry(sessionId), []);

  const sendChat = useCallback(async (event: React.FormEvent, fromHome = false) => {
    event.preventDefault();
    const body = chatDraft.trim();
    if (!body) return;
    setChatDraft("");
    setChatMessages((current) => [...current, { role: "user", body }]);
    await safeAction("正在准备回答", async () => {
      const value = dict(await api.chat({ ...(conversationId ? { sessionId: conversationId } : {}), message: body, prompt: body, context: { workspacePath: workspace?.path, screen } }));
      const raw = value;
      const session = dict(first(raw.session, raw));
      const id = stringValue(raw.chatId, raw.sessionId, raw.conversationId, raw.id, session.id);
      if (id) setConversationId(id);
      let answer = stringValue(raw.answer, raw.reply, raw.assistantMessage, raw.text, dict(raw.response).text);
      if (!answer && id) {
        let status = await readChatStatus(id);
        let completed = ["completed", "succeeded"].includes(stringValue(status.session?.status, status.status).toLowerCase());
        for (let attempt = 0; attempt < 120 && !completed && !["failed", "cancelled", "canceled"].includes(stringValue(status.session?.status, status.status).toLowerCase()); attempt += 1) {
          await waitFor(1000);
          status = await readChatStatus(id);
          completed = ["completed", "succeeded"].includes(stringValue(status.session?.status, status.status).toLowerCase());
        }
        const statusValue = stringValue(status.session?.status, status.status).toLowerCase();
        if (["failed", "cancelled", "canceled"].includes(statusValue)) throw new Error(stringValue(status.session?.error, "AI 对话未完成"));
        if (!completed) throw new Error("AI 仍在处理，当前没有显示旧回答。请稍后重试或查看技术详情。");
        answer = stringValue(status.assistantMessage, status.answer, status.reply);
      }
      if (!answer) throw new Error("AI 没有返回可显示的回答，请稍后重试。");
      setChatMessages((current) => [...current, { role: "assistant", body: answer }]);
      if (fromHome) navigate("assistant");
    });
  }, [chatDraft, conversationId, navigate, readChatStatus, safeAction, screen, workspace?.path]);

  const refreshConversation = useCallback(async () => {
    if (!conversationId) return;
    await safeAction("正在读取状态", async () => {
      const status = await readChatStatus(conversationId);
      const state = stringValue(status.session?.status, status.status).toLowerCase();
      if (["failed", "cancelled", "canceled"].includes(state)) {
        throw new Error(stringValue(status.session?.error, "AI 对话未完成"));
      }
      const answer = stringValue(status.assistantMessage, status.answer, status.reply);
      if (answer) {
        setChatMessages((current) => current.some((message) => message.role === "assistant" && message.body === answer)
          ? current
          : [...current, { role: "assistant", body: answer }]);
      }
    });
  }, [conversationId, readChatStatus, safeAction]);

  const cancelFlow = useCallback(() => {
    navigate(overview?.initialized ? "home" : "welcome");
  }, [navigate, overview?.initialized]);

  const renderError = () => error ? <div className="product-error" role="alert"><strong>这一步没有完成</strong><span>{error}</span><button className="button button-light" type="button" onClick={() => setError("")}>知道了</button></div> : null;

  const renderWelcome = () => (
    <main className="onboarding-shell" aria-labelledby="welcome-title">
      <header className="brand-row"><Brand /><span className="prototype-badge">中心库初始化</span></header>
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
          <div className="action-row"><button className="button button-quiet" type="button" onClick={cancelFlow}>稍后再说</button><button className="button button-dark" data-action="start-init-analysis" data-testid="start-init-analysis" type="button" disabled={!workspace?.path || Boolean(busy)} onClick={() => void analyzeWorkspace("initialize")}>{busy || "开始只读分析"}</button></div>
          <p className="safety-line"><span>✓</span> 分析阶段不会新增、删除或覆盖工作区里的任何文件。</p>
        </div>
        <aside className="explain-card" aria-label="初始化说明"><div className="explain-top"><span className="mini-label">你只需要做一次</span><span className="shield">✓</span></div><h2>建立第一个“项目方案”</h2><p>中心库可以保存少量不同项目方案。首次只建立一个，不会把不同项目强行混成同一套 Skill。</p><ol className="plain-steps"><li><span>1</span><div><strong>选择</strong><small>用 Windows 资源管理器选择文件夹</small></div></li><li><span>2</span><div><strong>分析</strong><small>自动区分方案内容、私有扩展和来源证据</small></div></li><li><span>3</span><div><strong>确认</strong><small>确认一个推荐项目方案</small></div></li><li><span>4</span><div><strong>创建</strong><small>保存为可比较、可回滚的方案 v1</small></div></li></ol><p className="no-jargon">不需要理解任何内部协议或运行细节。</p></aside>
      </section>
    </main>
  );

  const renderAnalysis = () => (
    <FlowChrome activeStep={2} title={flow === "update" ? "正在查看这个工作区的新变化" : "正在只读分析工作区"} subtitle={flow === "initialize" ? "第一次使用 · 第 2 步，共 4 步" : "工作区分析"} onCancel={cancelFlow} update={flow === "update"}>
      <div className="analysis-layout"><section className="analysis-visual card"><div className="scan-orbit" aria-hidden="true"><span>S</span><i /><i /><i /></div><div className="analysis-path"><small>正在分析</small><strong>{workspace?.path || "未选择工作区"}</strong></div><div className="progress-track"><span /></div><p>只读取目录、Git 索引与规则入口，结果出来前不会写入文件。</p></section><section className="check-card card"><p className="card-kicker">分析范围</p><div className="check-list"><div><span>✓</span><strong>查找 Skill、Agent 规则与清单</strong><small>已完成</small></div><div><span>✓</span><strong>核对 Git 记录与物理文件</strong><small>已完成</small></div><div><span>…</span><strong>识别链接、重复、缓存与版本关系</strong><small>正在归并</small></div></div><div className="inline-safety"><span>✓</span><p><strong>不会触碰用户改动</strong><small>不会 checkout、清理、attach 或恢复缺失文件。</small></p></div></section></div>
      <footer className="flow-actions"><button className="button button-quiet" type="button" onClick={cancelFlow}>取消分析</button><button className="button button-dark" data-action="show-analysis-results" data-testid="show-analysis-results" type="button" disabled={!analysis || Boolean(busy)} onClick={() => navigate(flow === "update" ? "update-review" : "analysis-results")}>{busy || "查看分析结果"} <span>→</span></button></footer>
    </FlowChrome>
  );

  const renderSystemCard = (item: System) => {
    const selectable = item.decision !== "reference-only" && (item.decision !== "keep-private" || (advanced && flow !== "initialize"));
    const checked = selectedSystems.has(item.id);
    return <article className={`system-card ${checked ? "selected" : ""} ${!selectable ? "reference" : ""}`} key={item.id}><div className="system-main"><label className="system-check"><input type="checkbox" checked={checked} disabled={!selectable} onChange={(event) => setSelectedSystems((current) => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} /><span /></label><div className="system-copy"><div className="system-title-row"><div><h3>{item.name}</h3><p>{item.subtitle || "Skill 与规则集合"}</p></div><span className={`decision-pill ${checked ? "chosen" : ""}`}>{checked ? "已选择" : item.decision === "keep-private" ? "留在工作区" : "仅作证据"}</span></div><div className="badge-row">{item.badges.map((badge) => <span key={badge}>{badge}</span>)}</div><p className="system-explain">{item.explanation || "来源和归并关系已经保留，是否纳入由你确认。"}</p><details className="source-details"><summary>查看 {item.sources.length} 个来源与归并依据</summary><div className="source-list">{item.sources.map((source) => <div key={`${source.kind}-${source.path}`}><span>{source.kind}</span><code>{source.path}</code></div>)}</div></details></div></div><div className="system-counts"><span><strong>{countLabel(item.skills, "0")}</strong> Skill</span><span><strong>{countLabel(item.rules, "0")}</strong> 规则</span><small>{item.confidence}</small></div></article>;
  };

  const renderAnalysisResults = () => (
    <FlowChrome activeStep={flow === "initialize" ? 3 : 2} title={flow === "initialize" ? "确认第一个项目方案" : "确认要连接的项目内容"} subtitle={flow === "initialize" ? "第一次使用 · 第 3 步，共 4 步" : `已完成 · ${workspace?.path || "工作区"}`} onCancel={cancelFlow} update={false}>
      <section className="result-summary card"><div><span className="success-dot">✓</span><div><strong>只读分析完成</strong><p>{workspace?.summary || "已整理 Skill、Agent 规则、链接、缓存、休眠记录和声明缺失。"}</p></div></div><div className="summary-facts"><span>别名不重复计数</span><span>缓存不作为来源</span><span>来源工作区保持原样</span></div></section>
      <div className="results-toolbar"><div><strong>{systems.length || "—"} 类分析结果</strong><span>{flow === "initialize" ? "首次只确认一个推荐项目方案。" : "默认选中用途相近的内容，私有扩展保留在原工作区。"}</span></div><button className="text-button" type="button" onClick={() => setAdvanced((value) => !value)}>{advanced ? "收起高级来源" : "高级：查看逐文件来源"}</button></div>
      <section className="systems-list" data-testid="analysis-results">{systems.length ? systems.map(renderSystemCard) : <div className="card empty-workspace"><span>⌕</span><div><strong>没有可确认的项目方案</strong><p>分析没有返回可纳入的内容，请返回工作区重新分析。</p></div><button className="button button-light" type="button" onClick={() => void analyzeWorkspace(flow)}>重新分析</button></div>}</section>
      {advanced && <div className="card plan-library-note"><span>i</span><p><strong>逐文件来源</strong><small>展开每个来源时仍保持只读。缓存、PackageCache、休眠条目和声明未落盘内容只作为证据，不会自动写入中心库。</small></p></div>}
      <aside className="protection-banner"><span>保护边界</span><p>休眠记录、未落盘声明、缓存与项目私有 Skill 不会被自动纳入、删除、覆盖或上传。</p><strong>{selectedSystems.size} 组内容将进入下一步</strong></aside>
      <footer className="flow-actions sticky-actions"><button className="button button-quiet" type="button" onClick={cancelFlow}>取消，什么都不做</button><button className="button button-dark" type="button" disabled={!selectedSystems.size || Boolean(busy)} data-testid={flow === "initialize" ? "preview-v1" : "choose-connect-mode"} onClick={() => flow === "initialize" ? navigate("init-preview") : navigate("connect-mode")}>{flow === "initialize" ? "预览项目方案 v1" : "继续：选择如何连接"} <span>→</span></button></footer>
    </FlowChrome>
  );

  const renderInitPreview = () => {
    const chosen = systems.filter((item) => selectedSystems.has(item.id));
    const totalSkills = chosen.reduce((sum, item) => sum + item.skills, 0);
    const totalRules = chosen.reduce((sum, item) => sum + item.rules, 0);
    return <FlowChrome activeStep={4} title="一眼确认，再创建第一个方案" subtitle="第一次使用 · 第 4 步，共 4 步" onCancel={cancelFlow}><div className="preview-grid"><section className="preview-main card"><div className="version-hero"><span>即将创建</span><strong>{overview?.libraryName || "项目方案"} v1</strong><p>这是一个新的、可比较且可回滚的方案起点。</p></div><div className="preview-metrics"><div><strong>1</strong><span>项目方案</span></div><div><strong>{totalSkills}</strong><span>Skill</span></div><div><strong>{totalRules}</strong><span>Agent 规则</span></div></div><h3>纳入范围</h3><div className="compact-system-list">{chosen.map((item) => <div key={item.id}><span className="mini-system-icon">{item.name.slice(0, 1)}</span><p><strong>{item.name}</strong><small>{item.confidence}</small></p><span>已选择</span></div>)}</div></section><aside className="boundary-card card"><p className="card-kicker">创建前确认</p><h2>只写入中心库数据区</h2><div className="boundary-list"><div><span>✓</span><p><strong>来源工作区保持原样</strong><small>{workspace?.path}</small></p></div><div><span>✓</span><p><strong>不纳入缓存与缺失记录</strong><small>它们仍作为分析证据保留</small></p></div><div><span>✓</span><p><strong>以后每次修改都生成新版本</strong><small>v1 永远可以查看和比较</small></p></div></div><label className="confirm-row"><input type="checkbox" checked readOnly /><span>我已查看纳入范围和保全边界</span></label></aside></div><footer className="flow-actions"><button className="button button-quiet" type="button" onClick={() => navigate("analysis-results")}>返回调整</button><button className="button button-dark" data-action="create-v1" data-testid="create-v1" type="button" disabled={Boolean(busy)} onClick={() => void initializeLibrary()}>{busy || "创建项目方案 v1"} <span>→</span></button></footer></FlowChrome>;
  };

  const renderInitSuccess = () => <main className="success-shell"><div className="success-card"><div className="success-mark">✓</div><p className="eyebrow">初始化完成</p><h1>{overview?.libraryName || "项目方案"} v1 已创建</h1><p>中心库现在包含第一个项目方案。来源工作区没有被修改。</p><div className="success-version"><span>v1</span><div><strong>{overview?.libraryName || "项目方案"}</strong><small>{countLabel(overview?.skillCount, "—")} 个 Skill</small></div><time>刚刚</time></div><div className="success-actions"><button className="button button-light" type="button" onClick={() => navigate("library")}>查看中心库</button><button className="button button-primary" data-testid="enter-home" type="button" onClick={() => navigate("home")}>进入工作区首页 →</button></div></div></main>;

  const shell = (content: React.ReactNode, active: "home" | "library" | "workspaces" | "assistant" | "diagnostics") => <div className="app-shell"><aside className="sidebar"><Brand onClick={() => navigate("home")} /><nav aria-label="主导航"><button className={active === "home" ? "active" : ""} type="button" onClick={() => navigate("home")}><span>⌂</span>首页{overviewChanges.length ? <i className="nav-dot" /> : null}</button><button className={active === "library" ? "active" : ""} type="button" onClick={() => navigate("library")}><span>▦</span>中心库</button><button className={active === "workspaces" ? "active" : ""} type="button" onClick={() => navigate("workspaces")}><span>◇</span>工作区{overviewChanges.length ? <i className="nav-dot" /> : null}</button><button className={active === "assistant" ? "active" : ""} type="button" onClick={() => navigate("assistant")}><span>✦</span>AI 助手</button></nav><div className="sidebar-bottom"><button type="button" onClick={() => navigate("diagnostics")}><span>⚙</span>设置与诊断</button><div className="profile-chip"><span>OZ</span><p><strong>本机中心库</strong><small>仅此设备</small></p><i>⌄</i></div></div></aside><main className="workspace-main"><header className="topbar"><button className="mobile-menu" type="button" aria-label="打开导航" onClick={() => navigate("home")}>☰</button><div className="global-search"><span>⌕</span><input aria-label="全局搜索" placeholder="搜索项目方案、Skill、规则或来源" /><kbd>Ctrl K</kbd></div><button className="top-icon" type="button" aria-label="帮助" onClick={() => navigate("diagnostics")}>?</button><button className="top-icon has-dot" type="button" aria-label="通知" onClick={() => overviewChanges.length ? openPendingUpdate() : void refreshOverview()}>○</button></header><div className="page-wrap">{content}</div></main></div>;

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
    return shell(<><header className="page-title home-heading"><div><p className="eyebrow">工作区首页</p><h1>上午好，中心库一切清晰。</h1><p>从这里处理新修改、查看已连接工作树，或直接和 AI 对话。</p></div><div className="page-actions"><button className="button button-dark" type="button" onClick={() => navigate("connect-select")}>＋ 连接工作区</button></div></header><div className="dashboard-grid"><section className={`home-update-card card ${overviewChanges.length ? "has-update" : "is-clear"}`} data-testid="home-update-card"><div className="home-update-icon">{overviewChanges.length ? "↗" : "✓"}</div><div className="home-update-copy"><span className="home-card-label">当前修改</span><h2>{overviewChanges.length ? `有 ${overviewChanges.length} 项新修改待处理` : "当前没有待处理修改"}</h2><p>{overviewChanges.length ? "先查看发生了什么，再决定融合进中心库。" : "连接的工作树会在这里显示新的 Skill 修改。"}</p></div><div className="home-update-actions">{overviewChanges.length ? <><button className="button button-primary" data-testid="home-view-update" type="button" onClick={openPendingUpdate}>查看新修改</button><button className="text-button" data-testid="home-trigger-update" type="button" onClick={() => void refreshOverview()}>重新检查</button></> : <button className="button button-light" type="button" onClick={() => void refreshOverview()}>重新检查</button>}</div></section><section className="card home-skill-count"><span className="home-card-label">中心库</span><strong>{countLabel(count)}</strong><h2>个 Skill</h2><p>{countLabel(overview?.planCount, "—")} 个项目方案可分别管理。</p><button className="button button-light" type="button" onClick={() => navigate("library")}>打开中心库 →</button></section></div><section className="section-block"><div className="section-heading"><div><p className="eyebrow">工作区</p><h2>已连接工作树</h2></div><button className="text-button" type="button" onClick={() => navigate("workspaces")}>查看全部 →</button></div><div className="workspace-list card">{worktrees.length ? worktrees.map((tree) => <button className="workspace-row" type="button" key={tree.path} onClick={() => { setWorkspace(tree); navigate("workspaces"); }}><span className="workspace-avatar">{tree.name.slice(0, 2).toUpperCase()}</span><div><strong>{tree.name}</strong><code>{tree.path}</code></div><span className={`status-pill ${tree.hasChanges ? "warn" : "ok"}`}>{tree.hasChanges ? "有新修改" : tree.status || "已连接"}</span><span>→</span></button>) : <div className="empty-workspace"><span>◇</span><div><strong>还没有已连接工作树</strong><p>连接一个工作区后，它会出现在这里。</p></div><button className="button button-light" type="button" onClick={() => navigate("connect-select")}>连接工作区</button></div>}</div></section><section className="home-ai-card card"><div className="home-shortcut-icon">✦</div><div><p className="home-card-label">快速开始</p><h2>和 AI 一起整理中心库</h2><p>描述你想修改的 Skill 或规则，AI 会先给出可预览草稿。</p></div><form className="home-ai-form" data-testid="home-ai-form" onSubmit={(event) => void sendChat(event, true)}><input data-testid="home-chat-input" aria-label="快速开始 AI 对话" placeholder="例如：把安装说明改得更容易读" value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} /><button className="send-button" data-testid="home-ai-submit" type="submit">→</button></form><button className="text-button" type="button" onClick={() => navigate("assistant")}>打开完整对话 →</button></section><div className="principles-strip"><div><span>◎</span><p><strong>先分析</strong><small>选择路径后不写文件</small></p></div><div><span>▣</span><p><strong>先预览</strong><small>每次写入前看清变化</small></p></div><div><span>↶</span><p><strong>可恢复</strong><small>版本和保全点都不删除历史</small></p></div></div></>, "home");
  };

  const renderConnectSelect = () => <FlowChrome activeStep={1} title="连接一个新的工作区" subtitle="连接工作区 · 第 1 步" onCancel={cancelFlow}><div className="connect-select-grid"><section className="connect-picker card"><div className="big-folder"><i /></div><p className="card-kicker">先选择，再分析</p><h2>{workspace?.name || "还没有选择工作区"}</h2><code>{workspace?.path || "Windows 原生资源管理器"}</code><p>连接前会先只读分析这个工作区的 Skill、规则、别名、重复内容和私有扩展。</p><button className="button button-primary" type="button" onClick={() => void chooseWorkspace("connect")}>用资源管理器选择</button><small>不会 attach、清理或覆盖工作区</small></section><aside className="connect-promises"><h3>连接前你会看到</h3><div><span>1</span><p><strong>有哪些项目方案</strong><small>不同项目不必强行合成一套</small></p></div><div><span>2</span><p><strong>哪些内容真的发生变化</strong><small>别名和缓存不会重复计算</small></p></div><div><span>3</span><p><strong>两种清晰选择</strong><small>融合进中心库，或使用中心库接管</small></p></div></aside></div><footer className="flow-actions"><button className="button button-quiet" type="button" onClick={cancelFlow}>取消</button><button className="button button-dark" data-testid="start-connect-analysis" type="button" disabled={!workspace?.path || Boolean(busy)} onClick={() => void analyzeWorkspace("connect")}>{busy || "开始只读分析"} <span>→</span></button></footer></FlowChrome>;

  const renderConnectMode = () => <FlowChrome activeStep={3} title="你希望怎样连接这个工作区？" subtitle="连接工作区 · 已完成分析" onCancel={cancelFlow}><div className="mode-intro card"><span className="success-dot">✓</span><div><strong>{workspace?.name || "工作区"} 已完成只读分析</strong><p>接下来只决定中心库与工作区的关系，不会自动修改私有内容。</p></div></div><div className="mode-grid"><button className="mode-card recommended" data-testid="choose-merge" type="button" onClick={() => void compareWorkspace("merge")}><span className="mode-icon">↗</span><span className="recommend-chip">推荐</span><h2>融合进中心库</h2><p>把新内容与中心库比较，解决冲突后生成一个新的中心库版本。</p><ul><li>保留来源和差异记录</li><li>冲突逐项确认</li><li>不覆盖项目私有 Skill</li></ul><strong>查看比较结果 <i>→</i></strong></button><button className="mode-card" data-testid="choose-takeover" type="button" onClick={() => void previewTakeover()}><span className="mode-icon">↓</span><h2>使用中心库接管</h2><p>预览将改动什么，再把中心库内容应用到这个工作区。</p><ul><li>先显示替换范围</li><li>保全本地私有内容</li><li>支持回滚接管</li></ul><strong>生成接管预览 <i>→</i></strong></button></div><button className="advanced-link" type="button" onClick={() => setAdvanced((value) => !value)}>高级：逐体系选择 <span>{advanced ? "⌃" : "⌄"}</span></button>{advanced && <div className="card plan-library-note"><span>i</span><p><strong>高级选择</strong><small>已在上一步列出体系；默认流程只需要做一次整体决策。当前已选择 {selectedSystems.size} 组内容。</small></p></div>}</FlowChrome>;

  const renderMerge = () => {
    const compareFiles = files;
    return <FlowChrome activeStep={4} title="先看清差异，再融合进中心库" subtitle="连接工作区 · 融合预览" onCancel={cancelFlow}><section className="compare-summary card"><div><small>来源工作区</small><strong>{workspace?.name || "工作区"}</strong></div><span>→</span><div><small>目标</small><strong>{overview?.libraryName || "中心库"}</strong></div><div className="compare-counts"><span><b>{compareFiles.length}</b> 个文件</span><span className="warn"><b>{compareFiles.filter((file) => file.status !== "新增").length}</b> 个需确认</span></div></section><div className="compare-layout"><section><div className="section-heading compact"><h2>文件差异</h2><span className="resolved-chip">只读比较</span></div><div className="change-table card"><div className="change-head"><span>文件</span><span>变化</span><span>状态</span></div>{compareFiles.length ? compareFiles.map((file) => <div key={file.id}><p><strong>{file.path}</strong><code>{file.skill}</code></p><span className="diff-add">+{file.additions} / −{file.deletions}</span><span>{file.status}</span></div>) : <div><p><strong>没有返回文件差异</strong><code>服务未提供比较内容</code></p><span>—</span><span>请重试</span></div>}</div></section><aside className="merge-receipt card"><p className="card-kicker">融合边界</p><h2>将生成新的中心库版本</h2><div className="receipt-list"><div><span>✓</span><p><strong>来源工作区保持原样</strong><small>{workspace?.path}</small></p></div><div><span>✓</span><p><strong>私有内容不会自动覆盖</strong><small>需要明确选择才会进入草稿</small></p></div><div><span>✓</span><p><strong>历史版本继续保留</strong><small>取消不会产生版本</small></p></div></div><label className="version-note"><span>版本说明（可选）</span><input aria-label="版本说明" placeholder="例如：融合 Unity MCP 更新" value={mergeNote} onChange={(event) => setMergeNote(event.target.value)} /></label></aside></div><footer className="flow-actions sticky-actions"><button className="button button-quiet" type="button" onClick={() => navigate("connect-mode")}>返回选择</button><button className="button button-dark" data-testid="save-merge" type="button" disabled={!compareFiles.length || Boolean(busy)} onClick={() => void createMergeDraft()}>{busy || "预览并保存新版本"} <span>→</span></button></footer></FlowChrome>;
  };

  const renderMergeSuccess = () => <main className="merge-complete-shell"><div className="merge-complete-hero"><div className="success-mark">✓</div><p className="eyebrow">融合完成</p><h1>新的中心库版本已保存</h1><p>{workspace?.name || "工作区"} 的选定内容已经进入中心库，来源工作区没有被覆盖。</p></div><div className="merge-result-grid"><section className="merge-receipt card"><p className="card-kicker">本次结果</p><h2>{overview?.libraryName || "中心库"}</h2><div className="receipt-stats"><div><strong>{files.length}</strong><span>文件</span></div><div><strong>新版本</strong><span>已生成</span></div><div><strong>可回滚</strong><span>历史保留</span></div></div><div className="merge-complete-boundary"><span>✓</span><p><strong>工作区保持原样</strong><small>如需让其他工作区使用中心库，可单独选择接管。</small></p></div></section></div><div className="merge-complete-actions"><button className="button button-light" type="button" onClick={() => navigate("library")}>查看中心库</button><button className="button button-dark" data-testid="finish-merge" type="button" onClick={() => navigate("home")}>回到首页 →</button></div></main>;

  const changeCard = (item: any) => { const row = dict(item); return <article className="skill-change-card" key={stringValue(row.id, row.path, row.name)}><div className="skill-change-icon">✦</div><div className="skill-change-summary"><strong>{stringValue(row.name, row.skillName, row.skill, row.path, "未命名 Skill")}</strong><p>{stringValue(row.summary, row.description, row.reason, "检测到来自已连接工作树的新修改。")}</p><span>{stringValue(row.path, row.workspacePath, row.worktreePath)}</span></div><span className="status-pill warn">有修改</span></article>; };

  const renderUpdateReview = () => <FlowChrome activeStep={1} update title="先查看工作区有哪些新修改" subtitle="工作区更新 · 第 1 步，共 3 步" onCancel={cancelFlow}><section className="update-hero card"><div className="update-hero-icon">↗</div><div><p className="card-kicker">只读发现</p><h2>{workspace?.name || "已连接工作区"} 有新的 Skill 修改</h2><p>这里只列出实际发生变化的 Skill 和大概内容。下一步再逐文件比较。</p></div><span className="update-hero-version">尚未写入</span></section><div className="simple-update-summary"><strong>{changedSkills.length || "—"} 个 Skill 有修改</strong><span>不会在此页合并或覆盖文件</span></div><section className="skill-change-list" data-testid="update-review">{changedSkills.length ? changedSkills.map(changeCard) : <div className="card empty-workspace"><span>✓</span><div><strong>没有可显示的新 Skill 修改</strong><p>{busy ? "正在读取并比较实际文件，请稍候。" : "这次检查没有发现与中心库不同的文件。"}</p></div><button className="button button-light" type="button" disabled={Boolean(busy)} onClick={() => workspace && void analyzeWorkspace("update", workspace)}>重新分析</button></div>}</section><footer className="flow-actions sticky-actions"><button className="button button-quiet" type="button" onClick={cancelFlow}>稍后处理</button><button className="button button-dark" data-testid="start-update-compare" type="button" disabled={Boolean(busy) || !files.length} onClick={() => navigate("update-compare")}>{busy || "查看文件差异"} <span>→</span></button></footer></FlowChrome>;

  const renderDiff = (file: ChangeFile) => {
    const lines = (file.diff || file.finalContent).split("\n");
    return <div className="github-diff">{lines.map((line, index) => { const isAdd = line.startsWith("+") && !line.startsWith("+++"); const isRemove = line.startsWith("-") && !line.startsWith("---"); return <div className={`github-diff-line ${isAdd ? "changed" : isRemove ? "diff-remove" : ""}`} key={`${file.id}-${index}`}><span>{index + 1}</span><b>{isAdd ? "+" : isRemove ? "−" : " "}</b><code>{line.replace(/^[+-]/, "")}</code></div>; })}</div>;
  };

  const renderUpdateCompare = () => <FlowChrome activeStep={2} update title="处理每个文件的差异" subtitle="工作区更新 · 第 2 步，共 3 步" onCancel={cancelFlow}><section className="simple-update-summary card"><div><strong>{files.length} 个文件发生变化</strong><span>像查看 GitHub 提交一样逐文件检查</span></div><span className="status-pill blue">尚未写入</span></section><div className="compare-layout"><section className="update-review-main"><div className="section-heading compact"><h2>逐文件差异</h2><span>新增 <b>{files.reduce((sum, file) => sum + file.additions, 0)}</b> · 删除 <b>{files.reduce((sum, file) => sum + file.deletions, 0)}</b></span></div><div className="diff-file-list">{files.length ? files.map((file) => <article className="diff-file card" key={file.id}><header><div><span className="status-pill warn">{file.status}</span><strong>{file.path}</strong><small>{file.skill}</small></div><span className="file-diff-count">+{file.additions} −{file.deletions}</span></header>{renderDiff(file)}</article>) : <div className="card empty-workspace"><span>⌕</span><div><strong>没有文件差异</strong><p>服务没有返回可处理的文件。</p></div></div>}</div></section><aside className="update-ai-panel card"><div className="update-ai-heading"><span className="ai-avatar">✦</span><div><strong>让 AI 帮你处理</strong><small>统一说明，生成可编辑草稿</small></div></div><textarea data-testid="ai-composer" value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="告诉 AI 如何处理这些修改" /><div className="result-ai-scope"><div className="result-ai-scope-actions"><strong>交给 AI 的文件</strong><button className="text-button" type="button" onClick={() => setAiFiles(aiFiles.size === files.length ? new Set() : new Set(files.map((file) => file.id)))}>{aiFiles.size === files.length ? "取消全选" : "全选"}</button></div><div className="result-ai-file-list">{files.map((file) => <label className={`result-ai-file-option ${aiFiles.has(file.id) ? "selected" : ""}`} key={file.id}><input data-testid="ai-file-checkbox" type="checkbox" checked={aiFiles.has(file.id)} onChange={(event) => setAiFiles((current) => { const next = new Set(current); if (event.target.checked) next.add(file.id); else next.delete(file.id); return next; })} /><span>{aiFiles.has(file.id) ? "✓" : ""}</span><div><strong>{file.path}</strong><small>{file.status}</small></div></label>)}</div></div><button className="button button-dark result-ai-submit" data-testid="process-update-ai" type="button" disabled={!files.length || !aiFiles.size || Boolean(busy)} onClick={() => void processAi(false)}>{busy || "处理并进入审阅"} <span>→</span></button><p className="simple-safety-note">AI 只生成草稿，不会直接合并。你仍可以逐文件编辑、确认或再次让 AI 修改。</p></aside></div><footer className="flow-actions"><button className="button button-quiet" type="button" onClick={() => navigate("update-review")}>返回修改概览</button><button className="button button-dark" type="button" disabled={!files.length || Boolean(busy)} onClick={() => void processAi(false)}>处理并审阅 <span>→</span></button></footer></FlowChrome>;

  const renderEditableFile = (file: ChangeFile) => {
    const content = file.finalContent;
    const changed = changedLineNumbers(file, content);
    return <article className={`result-file card ${confirmedFiles.has(file.id) ? "confirmed" : ""}`} key={file.id}>
      <header>
        <div><span className="status-pill warn" data-testid="change-status">{confirmedFiles.has(file.id) ? "已确认" : "待确认"}</span><strong>{file.path}</strong><small>{file.skill} · {file.status}</small></div>
        <div className="result-file-actions"><button className={`button ${confirmedFiles.has(file.id) ? "button-light" : "button-dark"}`} type="button" onClick={() => void confirmFile(file.id)}>{confirmedFiles.has(file.id) ? "取消确认" : "确认此文件"}</button></div>
      </header>
      <div className="result-inline-editor" data-testid="file-content">
        <div className="result-editor-highlights" aria-hidden="true"><div className="result-editor-highlight-lines">{content.split("\n").map((_, index) => <span className={changed.has(index + 1) ? "changed" : ""} key={index} />)}</div></div>
        <div className="result-editor-gutter-viewport"><div className="result-editor-gutter">{content.split("\n").map((_, index) => <span className={changed.has(index + 1) ? "changed" : ""} key={index}><i>{index + 1}</i><b>{changed.has(index + 1) ? "+" : ""}</b></span>)}</div></div>
        <textarea
          className="inline-result-editor"
          data-testid="file-editor"
          aria-label={`${file.path} 最终内容`}
          value={content}
          onChange={(event) => setFiles((current) => current.map((item) => item.id === file.id ? { ...item, finalContent: event.target.value } : item))}
          onScroll={(event) => {
            const container = event.currentTarget.parentElement;
            const offset = `translateY(-${event.currentTarget.scrollTop}px)`;
            const highlights = container?.querySelector<HTMLElement>(".result-editor-highlight-lines");
            const gutter = container?.querySelector<HTMLElement>(".result-editor-gutter");
            if (highlights) highlights.style.transform = offset;
            if (gutter) gutter.style.transform = offset;
          }}
          onBlur={(event) => void saveFile(file.id, event.target.value)}
        />
      </div>
      <p className="inline-edit-hint">可直接编辑；绿色行是本次修改。离开编辑框时自动保存草稿。</p>
    </article>;
  };

  const renderUpdateResult = () => <FlowChrome activeStep={3} update editable title="审阅最终结果，再确认合并" subtitle="工作区更新 · 第 3 步，共 3 步" onCancel={cancelFlow}><section className="result-overview card"><div><span className="success-dot">✦</span><div><strong>{flow === "connect" ? "融合草稿已准备" : "可编辑草稿已准备"}</strong><p>每个文件都可以直接点击、上下滚动和编辑；绿色背景表示本次新增或修改。</p></div></div><span className="result-progress">{confirmedFiles.size}/{files.length}<small>文件已确认</small></span></section><section className="result-ai-composer card"><div className="result-ai-heading"><span className="ai-avatar">✦</span><div><strong>继续让 AI 修改</strong><small>勾选文件后输入一次统一要求</small></div></div><div className="result-ai-composer-row"><textarea data-testid="ai-composer" value={resultPrompt} onChange={(event) => setResultPrompt(event.target.value)} placeholder="例如：保留命令，只把说明改成新同事能看懂的步骤" /><button className="button button-dark" data-testid="ai-submit" type="button" disabled={!files.length || Boolean(busy)} onClick={() => void processAi(true)}>{busy || "让 AI 修改"}</button></div><div className="result-ai-scope-actions"><strong>选择文件</strong><button className="text-button" type="button" onClick={() => setAiFiles(aiFiles.size === files.length ? new Set() : new Set(files.map((file) => file.id)))}>{aiFiles.size === files.length ? "取消全选" : "全选"}</button></div><div className="result-ai-file-list">{files.map((file) => <label className={`result-ai-file-option ${aiFiles.has(file.id) ? "selected" : ""}`} key={file.id}><input data-testid="ai-file-checkbox" type="checkbox" checked={aiFiles.has(file.id)} onChange={(event) => setAiFiles((current) => { const next = new Set(current); if (event.target.checked) next.add(file.id); else next.delete(file.id); return next; })} /><span>{aiFiles.has(file.id) ? "✓" : ""}</span><div><strong>{file.path}</strong><small>{confirmedFiles.has(file.id) ? "已确认" : "待确认"}</small></div></label>)}</div></section><section className="result-files" data-testid="file-content">{files.length ? files.map(renderEditableFile) : <div className="card empty-workspace"><span>⌕</span><div><strong>没有可审阅的文件</strong><p>请返回差异页重新获取草稿。</p></div><button className="button button-light" type="button" onClick={() => navigate("update-compare")}>返回差异</button></div>}</section><footer className="result-sticky-actions sticky-actions"><div><strong>{confirmedFiles.size}/{files.length}</strong><span>{files.length && confirmedFiles.size === files.length ? "所有文件已确认" : "请审阅并确认每个文件"}</span></div><button className="button button-dark" data-testid="confirm-update-merge" type="button" disabled={!files.length || confirmedFiles.size !== files.length || Boolean(busy)} onClick={() => void commitUpdate()}>{busy || "确认并合并回中心库"} <span>→</span></button></footer></FlowChrome>;

  const renderUpdateSuccess = () => <main className="merge-complete-shell"><div className="merge-complete-hero"><div className="success-mark">✓</div><p className="eyebrow">更新已合并</p><h1>中心库已保存这次修改</h1><p>已生成新的中心库版本；原工作区和历史版本仍可回看。</p></div><div className="merge-result-grid"><section className="merge-receipt card"><p className="card-kicker">已处理</p><h2>{files.length} 个文件</h2><div className="receipt-list"><div><span>✓</span><p><strong>每个文件都经过确认</strong><small>最终内容已经作为新版本保存。</small></p></div><div><span>↶</span><p><strong>可以回滚</strong><small>从中心库历史查看并恢复。</small></p></div></div></section></div><div className="merge-complete-actions"><button className="button button-light" type="button" onClick={() => navigate("library")}>查看中心库</button><button className="button button-dark" type="button" onClick={() => navigate("home")}>回到首页 →</button></div></main>;

  const renderTakeover = () => {
    const preview = comparison || {};
    const entries = array(first(preview.operations, preview.files, preview.changes, preview.paths));
    const requiresExplicit = Boolean(preview.requiresExplicit);
    const dirtyFiles = array(preview.dirtyFiles).map(String);
    return <FlowChrome activeStep={4} title="确认中心库将如何接管" subtitle="连接工作区 · 接管预览" onCancel={cancelFlow}><div className="takeover-warning"><span>!</span><div><strong>这一步会写入工作区</strong><p>请确认保全边界。项目私有 Skill 未经选择不会被覆盖或删除。</p></div></div><div className="takeover-grid"><section className="takeover-column card"><div className="column-title"><span>库</span><div><strong>中心库将提供</strong><small>{overview?.libraryName || "中心库"}</small></div></div>{entries.length ? entries.map((entry, index) => <div className="path-item" key={index}><span>{stringValue(dict(entry).action, "修改")}</span><p><strong>{stringValue(dict(entry).path, dict(entry).name, `内容 ${index + 1}`)}</strong><code>{stringValue(dict(entry).targetPath, dict(entry).source)}</code></p></div>) : <div className="path-item"><span>—</span><p><strong>预览没有返回路径</strong><code>请重试预览</code></p></div>}</section><section className="takeover-column card"><div className="column-title"><span>保</span><div><strong>明确保全</strong><small>不会自动处理</small></div></div><div className="path-item"><span>保留</span><p><strong>项目私有 Skill</strong><code>未经明确选择不覆盖</code></p></div><div className="path-item"><span>保留</span><p><strong>未列入预览的内容</strong><code>不删除、不清理</code></p></div></section><section className="takeover-column card"><div className="column-title"><span>回</span><div><strong>可恢复</strong><small>应用后仍可回滚</small></div></div><div className="path-item"><span>记录</span><p><strong>接管前保全点</strong><code>由服务保存回滚边界</code></p></div></section></div>{requiresExplicit && <label className="confirm-row card"><input type="checkbox" checked={confirmDirtyTakeover} onChange={(event) => setConfirmDirtyTakeover(event.target.checked)} /><span>预览中有 {dirtyFiles.length} 个本地已修改文件；我已逐项查看并明确同意按预览覆盖。</span></label>}<div className="protection-point card"><div><span>✓</span><p><strong>只应用预览中列出的中心库内容</strong><small>其它工作区内容保持不变。</small></p></div><button className="button button-dark" data-testid="apply-takeover" type="button" disabled={!entries.length || Boolean(busy) || (requiresExplicit && !confirmDirtyTakeover)} onClick={() => void applyTakeover()}>{busy || "确认接管"}</button></div></FlowChrome>;
  };

  const renderTakeoverSuccess = () => <main className="merge-complete-shell"><div className="merge-complete-hero"><div className="success-mark">✓</div><p className="eyebrow">接管完成</p><h1>{workspace?.name || "工作区"} 已使用中心库</h1><p>应用范围已按预览执行，项目私有内容和原有保全边界仍然保留。</p></div><div className="merge-complete-actions"><button className="button button-light" type="button" onClick={() => void safeAction("正在回滚接管", async () => { await api.takeoverRollback({ protectionId: stringValue(comparison?.protectionId) }); await refreshOverview(); navigate("home"); })}>回滚这次接管</button><button className="button button-dark" type="button" onClick={() => navigate("home")}>回到首页 →</button></div></main>;

  const renderLibrary = () => { const currentSystems = filteredSystems; const currentFiles = libraryFiles; const active = activeFile || currentFiles[0] || null; return shell(<><header className="page-title"><div><p className="eyebrow">中心库</p><h1>{overview?.libraryName || "中心库"}</h1><p>查看体系、Skill、Agent 规则和来源；每次保存都会产生一个新版本。</p></div><div className="page-actions"><button className="button button-primary" type="button" onClick={() => navigate("assistant")}>✦ 让 AI 修改</button><button className="button button-dark" type="button" onClick={() => setLibraryTab("files")}>＋ 新建草稿</button></div></header><div className="library-tabs"><button className={libraryTab === "systems" ? "active" : ""} type="button" onClick={() => setLibraryTab("systems")}>体系</button><button className={libraryTab === "files" ? "active" : ""} type="button" onClick={() => setLibraryTab("files")}>文件与规则 <span>{currentFiles.length}</span></button><button className={libraryTab === "history" ? "active" : ""} type="button" onClick={() => setLibraryTab("history")}>版本历史 <span>{history.length}</span></button><div className="version-select"><span>查看版本</span><button type="button" onClick={() => setLibraryTab("history")}>{activeVersion}⌄</button></div></div>{libraryTab === "history" ? <section className="history-layout"><div className="version-row card"><div><span className="version-chip current">当前</span><strong>{activeVersion}</strong><small>中心库当前版本</small></div><button className="button button-light" type="button" onClick={() => setLibraryTab("systems")}>查看当前内容</button></div>{history.length ? history.map((item, index) => <div className="version-row card" key={stringValue(dict(item).id, dict(item).version, index)}><div><span className="version-chip">{stringValue(dict(item).versionId, dict(item).version, dict(item).number, `v${index + 1}`)}</span><strong>{stringValue(dict(item).message, dict(item).note, "中心库版本")}</strong><small>{stringValue(dict(item).createdAt, dict(item).date)}</small></div><div className="version-actions"><button className="button button-light" type="button" onClick={() => void safeAction("正在比较版本", async () => { if (!activePlanId) throw new Error("中心库尚未返回项目方案编号。"); const value = await api.versionCompare({ planId: activePlanId, fromVersion: stringValue(dict(item).versionId, dict(item).version), toVersion: activeVersion }); setComparison(dict(value)); })}>比较</button><button className="button button-light" type="button" onClick={() => { if (!window.confirm("确认生成一个回滚版本吗？原历史仍会保留。")) return; void safeAction("正在生成回滚版本", async () => { if (!activePlanId) throw new Error("中心库尚未返回项目方案编号。"); await api.rollbackVersion({ planId: activePlanId, versionId: stringValue(dict(item).versionId, dict(item).version) }); await refreshOverview(); }); }}>回滚</button></div></div>) : <div className="history-help card"><strong>还没有可显示的历史</strong><span>保存新草稿后会在这里留下可回滚的版本。</span></div>}{comparison && normalizeFiles(comparison).length ? <section className="card diff-view"><div className="diff-summary"><strong>版本差异</strong><span>只读比较</span></div>{normalizeFiles(comparison).map((file) => <div className="diff-file" key={file.id}>{renderDiff(file)}</div>)}</section> : null}</section> : <div className="library-layout"><aside className="system-browser card"><label className="local-search"><span>⌕</span><input data-testid="library-search" value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder="搜索体系或 Skill" /></label><div className="system-browser-list">{currentSystems.length ? currentSystems.map((item) => <button className={item.id === (active?.id || "") ? "active" : ""} type="button" key={item.id} onClick={() => { const file = currentFiles.find((candidate) => candidate.skill === item.name) || currentFiles[0]; if (file) void openLibraryFile(file); }}><span className="library-glyph">◇</span><p><strong>{item.name}</strong><small>{item.skills} Skill · {item.rules} 规则</small></p><i>›</i></button>) : <div className="empty-workspace"><span>⌕</span><div><strong>暂无体系</strong><p>初始化中心库后会显示内容。</p></div></div>}</div><div className="plan-library-note"><span>i</span><p><strong>中心库按项目方案分开</strong><small>用途明显不同的项目可以建立不同方案，不会强行混合。</small></p></div></aside><section className="system-detail card"><header><div><span className="detail-icon">O</span><div><h2>{active?.skill || "中心库内容"}</h2><code>{active?.path || overview?.hubRoot || "尚未选择文件"}</code></div></div><div><button className="button button-light" type="button" onClick={() => navigate("assistant")}>让 AI 修改</button><button className="button button-dark" type="button" onClick={() => active && void safeAction("正在创建草稿", async () => { if (!activePlanId) throw new Error("中心库尚未返回项目方案编号。"); const value = await api.libraryDraft({ planId: activePlanId, paths: active ? [active.path] : [] }); const id = payloadId(value); if (!id) throw new Error("请先从工作区比较后再创建草稿。"); const nextFiles = normalizeFiles(value).filter((file) => file.path === active.path); setDraft(dict(value)); setFiles(nextFiles); setAiFiles(new Set(nextFiles.map((file) => file.id))); setConfirmedFiles(new Set()); setFlow("update"); navigate("update-result"); })}>手动修改</button></div></header>{active ? <><div className="detail-metrics"><div><strong>{countLabel(activeFile ? active.finalContent.split("\n").length : "—")}</strong><span>行</span></div><div><strong>{countLabel(active.additions, "0")}</strong><span>新增</span></div><div><strong>{countLabel(active.deletions, "0")}</strong><span>删除</span></div><div><strong>{activeVersion}</strong><span>当前版本</span></div></div><div className="file-explorer card"><aside><p className="tree-label">文件</p>{currentFiles.map((file) => <button className={`tree-item ${file.id === active.id ? "active" : ""}`} key={file.id} type="button" onClick={() => void openLibraryFile(file)}>{file.path}</button>)}</aside><section><header><div><strong>{active.path}</strong><code>{active.status}</code></div><span className="status-pill soft">只读查看</span></header><div className="code-view" data-testid="file-content"><ol>{active.finalContent.split("\n").map((line, index) => <li key={index}><code>{line || " "}</code></li>)}</ol></div><footer className="simple-safety-note">编辑前会先创建草稿；原版本和来源保持可回滚。</footer></section></div></> : <div className="empty-workspace"><span>⌕</span><div><strong>选择一个文件查看内容</strong><p>中心库 API 没有返回文件列表。</p></div></div>}</section></div>}</>, "library"); };

  const renderWorkspaces = () => shell(<><header className="page-title"><div><p className="eyebrow">工作区</p><h1>已连接与待连接</h1><p>每个工作区先分析，再决定融合或接管。</p></div><div className="page-actions"><button className="button button-dark" type="button" onClick={() => navigate("connect-select")}>＋ 连接工作区</button></div></header><section className="workspace-cards">{worktrees.length ? worktrees.map((tree) => <article className="workspace-card card" key={tree.path}><div className="workspace-meta"><span className="workspace-avatar">{tree.name.slice(0, 2).toUpperCase()}</span><div><strong>{tree.name}</strong><code>{tree.path}</code></div><span className={`status-pill ${tree.hasChanges ? "warn" : "ok"}`}>{tree.hasChanges ? "有新修改" : tree.status || "已连接"}</span></div><p>{tree.hasChanges ? "工作区有新的 Skill 修改，可以进入发现变化流程。" : "中心库和工作区已连接。"}</p><div className="version-actions"><button className="button button-light" type="button" onClick={() => { if (tree.hasChanges) openWorkspaceUpdate(tree); else { setWorkspace(tree); navigate("connect-select"); } }}>{tree.hasChanges ? "查看新修改" : "重新分析"}</button></div></article>) : <div className="empty-workspace card"><span>◇</span><div><strong>还没有已连接工作树</strong><p>选择一个工作区开始分析。</p></div><button className="button button-dark" type="button" onClick={() => navigate("connect-select")}>连接工作区</button></div>}</section></>, "workspaces");

  const renderAssistant = () => shell(<><header className="page-title"><div><p className="eyebrow">AI 助手</p><h1>把想法说清楚，先看草稿。</h1><p>这是正常的对话页面。技术状态只在下方详情里显示。</p></div><div className="page-actions"><button className="button button-light" type="button" onClick={() => { setChatMessages([]); setConversationId(""); }}>新对话</button></div></header><section className="assistant-page"><div className="chat-panel card"><div className="chat-scroll">{chatMessages.length ? chatMessages.map((message, index) => <div className={`chat-row ${message.role}`} key={`${message.role}-${index}`}><span className={`avatar ${message.role === "assistant" ? "ai-avatar" : "user-avatar"}`}>{message.role === "assistant" ? "✦" : "我"}</span><div className="bubble"><p>{message.body}</p>{message.proposal && <span className="proposal-card">可预览修改范围</span>}</div></div>) : <div className="empty-workspace"><span>✦</span><div><strong>从一个问题开始</strong><p>例如：请检查 Unity MCP 的安装说明，并告诉我哪些文件适合一起修改。</p></div></div>}</div><form className="composer" data-testid="chat-form" onSubmit={(event) => void sendChat(event)}><textarea data-testid="chat-input" aria-label="AI 对话输入" value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} placeholder="告诉 AI 你想查看或修改什么" /><button className="button button-dark" type="submit" disabled={!chatDraft.trim() || Boolean(busy)}>{busy || "发送"} <span>→</span></button></form></div><aside className="conversation-list card"><p className="card-kicker">本次对话</p><h2>{conversationId ? "已连接" : "新的对话"}</h2><p>AI 的修改会先形成草稿，进入比较和审阅后才会写入中心库。</p><details className="tech-details"><summary>技术详情</summary><code>{conversationId || "尚未建立会话"}</code><button className="button button-light" type="button" disabled={!conversationId} onClick={() => void refreshConversation()}>刷新状态</button></details></aside></section></>, "assistant");

  const renderDiagnostics = () => shell(<><header className="page-title"><div><p className="eyebrow">高级诊断</p><h1>只在需要时查看技术详情。</h1><p>这里不参与主流程；可用于确认服务是否可访问和保全边界。</p></div></header><div className="diagnostic-grid"><section className="diagnostic-card card"><strong>产品 API</strong><span>主流程通过 product API 读取和写入。</span><button className="button button-light" type="button" onClick={() => void safeAction("正在检查中心库", async () => { await refreshOverview(); })}>重新检查中心库</button></section><section className="diagnostic-card card"><strong>当前操作</strong><span>{busy || "没有正在执行的写入"}</span><button className="button button-light" type="button" onClick={() => setError("")}>清除提示</button></section></div><details className="tech-details card"><summary>显示原始响应摘要</summary><pre>{JSON.stringify({ initialized: overview?.initialized, changes: overviewChanges.length, worktrees: worktrees.length }, null, 2)}</pre></details></>, "diagnostics");

  const renderRecovery = () => <main className="success-shell"><div className="success-card"><div className="recovery-icon">!</div><p className="eyebrow">操作未完成</p><h1>当前没有应用任何变更</h1><p>{error || "服务暂时不可用，或者操作被取消。你可以安全重试；工作区和中心库都保持原样。"}</p><div className="success-actions"><button className="button button-light" type="button" onClick={() => void refreshOverview().then(() => navigate(overview?.initialized ? "home" : "welcome")).catch((caught) => setError(errorMessage(caught)))}>重试</button><button className="button button-primary" type="button" onClick={() => navigate("home")}>返回首页</button></div></div></main>;

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
  else if (screen === "merge") content = renderMerge();
  else if (screen === "merge-success") content = renderMergeSuccess();
  else if (screen === "update-review") content = renderUpdateReview();
  else if (screen === "update-compare") content = renderUpdateCompare();
  else if (screen === "update-result") content = renderUpdateResult();
  else if (screen === "update-success") content = renderUpdateSuccess();
  else if (screen === "takeover") content = renderTakeover();
  else if (screen === "takeover-success") content = renderTakeoverSuccess();
  else if (screen === "library") content = renderLibrary();
  else if (screen === "workspaces") content = renderWorkspaces();
  else if (screen === "assistant") content = renderAssistant();
  else if (screen === "diagnostics") content = renderDiagnostics();
  else content = renderRecovery();

  const pathFallback = (screen === "welcome" || screen === "connect-select") ? <details className="manual-path-fallback"><summary>文件夹选择器未显示？</summary><div><label htmlFor="manual-workspace-path">手动输入工作区路径</label><input id="manual-workspace-path" data-testid="manual-workspace-path" value={manualWorkspacePath} onChange={(event) => setManualWorkspacePath(event.target.value)} placeholder="例如 E:\\ozdqp-skill-hub" /><button className="button button-light" data-testid="use-manual-workspace" type="button" onClick={applyManualWorkspacePath}>使用这个路径</button><small>这是兼容性后备入口；默认仍使用 Windows 原生文件夹选择器。</small></div></details> : null;
  return <>{content}{pathFallback}{renderError()}</>;
}
