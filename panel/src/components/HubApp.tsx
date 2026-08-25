"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CommandPalette,
  HubShell,
  StatusBar,
  useToast,
  type AttentionItem,
  type HubNavId,
  type HubStatus,
} from "graft-glass-ui/src/components";
import { createPanelApi } from "../../lib/api.mjs";
import {
  codexSessionHref,
  hrefForNav,
  mapOverview,
  navFromPath,
  queuedSessionView,
  searchParam,
  updateIdFromLocation,
} from "../../lib/overview-mapping.mjs";
import { buildPaletteEntries, filterPaletteEntries, HUB_QUICK_LINKS } from "../../lib/palette.mjs";
import { CodexView } from "./pages/CodexView";
import { SettingsView } from "./pages/SettingsView";
import { SkillsView } from "./pages/SkillsView";
import { StoreView } from "./pages/StoreView";
import { UpdatesView } from "./pages/UpdatesView";
import { WorkspacesView } from "./pages/WorkspacesView";

const api = createPanelApi();

type Loc = { path: string; search: string };

function readLoc(): Loc {
  if (typeof window === "undefined") return { path: "/", search: "" };
  return { path: window.location.pathname || "/", search: window.location.search || "" };
}

function afterNextPaint(run: () => void) {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => run());
    return;
  }
  setTimeout(run, 0);
}

export function HubApp() {
  const { toast } = useToast();
  const [loc, setLoc] = useState<Loc>({ path: "/", search: "" });
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyPath, setBusyPath] = useState("");
  const [registeringWorktree, setRegisteringWorktree] = useState(false);
  const [queued, setQueued] = useState<Record<string, ReturnType<typeof queuedSessionView>>>({});
  const [state, setState] = useState<Record<string, unknown> | null>(null);
  const [worktrees, setWorktrees] = useState<Record<string, unknown> | null>(null);
  const [worktreesLoading, setWorktreesLoading] = useState(false);
  const [worktreesError, setWorktreesError] = useState("");
  const [daemon, setDaemon] = useState<Record<string, unknown> | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [diagnosticsChecked, setDiagnosticsChecked] = useState(false);
  const [sessionsPayload, setSessionsPayload] = useState<{ sessions?: unknown[] } | null>(null);
  const loadGeneration = useRef(0);

  const push = useCallback((href: string) => {
    const url = new URL(href, window.location.origin);
    const next = { path: url.pathname || "/", search: url.search || "" };
    window.history.pushState({}, "", `${next.path}${next.search}`);
    setLoc(next);
  }, []);

  useEffect(() => {
    setLoc(readLoc());
    setReady(true);
    const onPop = () => setLoc(readLoc());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const loadSecondary = useCallback(async (generation: number) => {
    if (generation !== loadGeneration.current) return;

    const worktreesRequest = api.getWorktrees()
      .then((value) => {
        if (generation !== loadGeneration.current) return;
        setWorktrees(value);
        setWorktreesError("");
      })
      .catch((err) => {
        if (generation !== loadGeneration.current) return;
        setWorktrees(null);
        setWorktreesError(String((err as Error).message || err));
      })
      .finally(() => {
        if (generation === loadGeneration.current) setWorktreesLoading(false);
      });

    const sessionsRequest = api.getSessions()
      .then((value) => {
        if (generation === loadGeneration.current) setSessionsPayload(value);
      })
      .catch(() => {
        if (generation === loadGeneration.current) setSessionsPayload(null);
      });

    await Promise.allSettled([worktreesRequest, sessionsRequest]);
    if (generation !== loadGeneration.current) return;

    try {
      const diagnosticsValue = await api.getDiagnostics();
      if (generation !== loadGeneration.current) return;
      setDiagnostics(diagnosticsValue);
      setDaemon(
        diagnosticsValue && typeof diagnosticsValue.daemon === "object"
          ? diagnosticsValue.daemon as Record<string, unknown>
          : { ok: false },
      );
    } catch {
      if (generation !== loadGeneration.current) return;
      setDiagnostics(null);
      setDaemon({ ok: false });
    } finally {
      if (generation === loadGeneration.current) setDiagnosticsChecked(true);
    }
  }, []);

  const load = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoading(true);
    setError("");
    setWorktreesLoading(false);
    setDiagnostics(null);
    setDiagnosticsChecked(false);
    setDaemon(null);
    try {
      const stateValue = await api.getState();
      if (generation !== loadGeneration.current) return;
      setState(stateValue);
      setLoading(false);
      setWorktreesLoading(true);
      setWorktreesError("");
      afterNextPaint(() => {
        if (generation === loadGeneration.current) void loadSecondary(generation);
      });
    } catch (err) {
      if (generation !== loadGeneration.current) return;
      setError(String((err as Error).message || err));
      setLoading(false);
    }
  }, [loadSecondary]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load]);

  const overview = useMemo(
    () =>
      mapOverview({
        state,
        stateChecked: !loading,
        worktrees,
        worktreesPhase: worktreesLoading ? "loading" : worktreesError ? "error" : worktrees ? "ready" : "loading",
        diagnostics,
        diagnosticsChecked,
      }),
    [state, loading, worktrees, worktreesLoading, worktreesError, diagnostics, diagnosticsChecked],
  );

  const nav = navFromPath(loc.path) as HubNavId;
  const updateId = updateIdFromLocation(loc.path, loc.search);
  const skillPath = searchParam(loc.search, "path");
  const workspacePath = searchParam(loc.search, "path");
  const sessionId = searchParam(loc.search, "id");
  const paletteEntries = useMemo(
    () => buildPaletteEntries({ state, worktrees }),
    [state, worktrees],
  );
  const paletteResults = useMemo(
    () => filterPaletteEntries(paletteEntries, paletteQuery),
    [paletteEntries, paletteQuery],
  );
  const sessions = ((sessionsPayload && sessionsPayload.sessions) || []) as Array<{
    id: string;
    kind?: string;
    status?: string;
    canResume?: boolean;
  }>;
  const items = ((state && (state as { items?: unknown[] }).items) || []) as Array<{
    id: string;
    name?: string;
    status?: string;
  }>;

  const showQueued = useCallback((session: unknown, key?: string) => {
    const view = queuedSessionView(session);
    if (key) setQueued((prev) => ({ ...prev, [key]: view }));
    toast({
      type: "info",
      title: view.label || "已入队",
      description: [view.id, view.status].filter(Boolean).join(" · "),
    });
    return view;
  }, [toast]);

  const onAttentionPrimary = async (item: AttentionItem) => {
    if (item.kind === "update") {
      push(`/updates/${encodeURIComponent(item.id)}`);
      return;
    }
    const path = (item as AttentionItem & { path?: string }).path;
    if (path) {
      setBusy(true);
      setBusyPath(path);
      try {
        const session = await api.attachWorktree(path, "面板修复工作区");
        showQueued(session, path);
      } catch (err) {
        toast({ type: "error", title: "attach 失败", description: String((err as Error).message || err) });
        push("/workspaces");
      } finally {
        setBusy(false);
        setBusyPath("");
      }
      return;
    }
    push("/workspaces");
  };

  const runDecide = async (id: string, action: string, extra: { note?: string; mergeTarget?: string } = {}) => {
    setBusy(true);
    try {
      await api.decide(id, action, {
        ...(extra.note ? { note: extra.note } : {}),
        ...(extra.mergeTarget ? { mergeTarget: extra.mergeTarget } : {}),
      });
      toast({ type: "success", title: `decide ${action}`, description: id });
      await load();
    } catch (err) {
      toast({ type: "error", title: "decide 失败", description: String((err as Error).message || err) });
    } finally {
      setBusy(false);
    }
  };

  const runAnalyze = async () => {
    setBusy(true);
    try {
      const session = await api.analyze();
      showQueued(session);
    } catch (err) {
      toast({ type: "error", title: "analyze 失败", description: String((err as Error).message || err) });
    } finally {
      setBusy(false);
    }
  };

  const runAttach = async (path: string) => {
    setBusy(true);
    setBusyPath(path);
    try {
      const session = await api.attachWorktree(path, "面板连接工作区");
      showQueued(session, path);
    } catch (err) {
      toast({ type: "error", title: "attach 失败", description: String((err as Error).message || err) });
    } finally {
      setBusy(false);
      setBusyPath("");
    }
  };

  const runRegisterWorktree = async (path: string) => {
    setRegisteringWorktree(true);
    try {
      const result = await api.registerWorktree(path);
      setWorktrees(result);
      setWorktreesError("");
      const selected = typeof result.worktree === "string" ? result.worktree : "";
      toast({
        type: "success",
        title: result.changed ? "工作树已添加" : "工作树已登记",
        description: selected || path,
      });
      if (selected) push(`/workspaces?path=${encodeURIComponent(selected)}`);
    } catch (err) {
      toast({ type: "error", title: "添加工作树失败", description: String((err as Error).message || err) });
    } finally {
      setRegisteringWorktree(false);
    }
  };

  const runDetach = async (path: string) => {
    setBusy(true);
    setBusyPath(path);
    try {
      const session = await api.detachWorktree(path, "面板断开工作区");
      showQueued(session, path);
    } catch (err) {
      toast({ type: "error", title: "detach 失败", description: String((err as Error).message || err) });
    } finally {
      setBusy(false);
      setBusyPath("");
    }
  };

  const shell = {
    active: nav,
    user: overview.user,
    updateCount: overview.updateCount,
    greetingName: overview.displayName,
    envLabel: overview.envLabel,
    stats: overview.stats,
    attention: overview.attention,
    workspaces: overview.workspaces,
    librarySkillCount: state ? overview.librarySkillCount : undefined,
    connectedSkillCount: state ? overview.connectedSkillCount : undefined,
    git: overview.git as { status: HubStatus; label: string },
    repository: overview.repository as { status: HubStatus; label: string },
    codex: overview.codex as { status: HubStatus; label: string },
    storage: overview.storage,
    workspacesLoading: worktreesLoading,
    workspacesError: worktreesError,
    onNavigate: (id: HubNavId) => push(hrefForNav(id)),
    onSearch: () => setPaletteOpen(true),
    onCreate: () => push("/codex"),
    onNotify: () => push("/updates"),
    onAttentionPrimary,
    onAttentionSecondary: (item: AttentionItem) => push(`/updates/${encodeURIComponent(item.id)}`),
    onSeeAllAttention: () => push("/updates"),
    onSeeAllWorkspaces: () => push("/workspaces"),
    onSelectWorkspace: (item: { id: string; path?: string }) => {
      const path = item.path || item.id;
      push(`/workspaces?path=${encodeURIComponent(path)}`);
    },
    onEmptyAction: () => push("/codex"),
    onRefresh: () => {
      void load();
    },
  };

  if (!ready) {
    return <div className="min-h-screen bg-page" />;
  }

  const inner = (() => {
    if (loading && !state) {
      return (
        <div className="glass rounded-[22px] p-8 text-ink/45">
          <div className="text-[15px] font-[600] text-ink/65">正在加载技能库状态…</div>
          <div className="mt-2 text-[12.5px]">阶段 1/3 · 工作树扫描与 Runner 检测将在首屏状态显示后继续。</div>
        </div>
      );
    }
    if (error && !state) {
      return <div className="glass rounded-[22px] p-8 text-orange-600">{error}</div>;
    }
    if (nav === "skills") {
      const s = (state || {}) as { resident?: []; adopted?: []; inbox?: [] };
      return (
        <SkillsView
          resident={s.resident || []}
          adopted={s.adopted || []}
          inbox={s.inbox || []}
          selectedPath={skillPath}
          onSelect={(path) => push(`/skills?path=${encodeURIComponent(path)}`)}
        />
      );
    }
    if (nav === "updates") {
      return (
        <UpdatesView
          items={items}
          selectedId={updateId}
          busy={busy}
          onSelect={(id) => push(`/updates/${encodeURIComponent(id)}`)}
          onAnalyze={runAnalyze}
          onDecide={runDecide}
        />
      );
    }
    if (nav === "workspaces") {
      return (
        <WorkspacesView
          items={overview.workspaces}
          selectedPath={workspacePath}
          queued={queued}
          busyPath={busyPath}
          registeringWorktree={registeringWorktree}
          onSelect={(path) => push(`/workspaces?path=${encodeURIComponent(path)}`)}
          onRegisterWorktree={runRegisterWorktree}
          onAttach={runAttach}
          onDetach={runDetach}
        />
      );
    }
    if (nav === "store") return <StoreView />;
    if (nav === "codex") {
      return (
        <CodexView
          sessions={sessions}
          worktrees={overview.workspaces}
          selectedId={sessionId}
          busy={busy}
          onSelect={(id) => push(`/codex?id=${encodeURIComponent(id)}`)}
          onStart={async (body) => {
            setBusy(true);
            try {
              const session = await api.startCodex(body);
              showQueued(session);
              const href = codexSessionHref(session);
              if (href) push(href);
              await load();
            } catch (err) {
              toast({ type: "error", title: "start 失败", description: String((err as Error).message || err) });
            } finally {
              setBusy(false);
            }
          }}
          onResume={async (id, message) => {
            setBusy(true);
            try {
              const session = await api.resumeCodex(id, message);
              showQueued(session);
              await load();
            } catch (err) {
              toast({ type: "error", title: "resume 失败", description: String((err as Error).message || err) });
            } finally {
              setBusy(false);
            }
          }}
          onCancel={async (id) => {
            setBusy(true);
            try {
              const session = await api.cancelCodex(id);
              const view = queuedSessionView(session);
              toast({
                type: "info",
                title: "取消请求已处理",
                description: [view.id, view.status].filter(Boolean).join(" · "),
              });
              await load();
            } catch (err) {
              toast({ type: "error", title: "cancel 失败", description: String((err as Error).message || err) });
            } finally {
              setBusy(false);
            }
          }}
        />
      );
    }
    if (nav === "settings") {
      return (
        <SettingsView
          hubRoot={overview.hubRoot}
          gameRepo={overview.gameRepo}
          daemon={daemon}
          diagnostics={diagnostics}
        />
      );
    }
    return null;
  })();

  return (
    <>
      {nav === "overview" && !inner ? (
        <HubShell {...shell} />
      ) : (
        <HubShell {...shell}>
          {inner}
          <StatusBar
            librarySkillCount={state ? overview.librarySkillCount : undefined}
            connectedSkillCount={state ? overview.connectedSkillCount : undefined}
            git={overview.git as { status: HubStatus; label: string }}
            repository={overview.repository as { status: HubStatus; label: string }}
            codex={overview.codex as { status: HubStatus; label: string }}
            storage={overview.storage}
            onRefresh={() => void load()}
          />
        </HubShell>
      )}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        quickLinks={HUB_QUICK_LINKS}
        results={paletteQuery ? paletteResults : []}
        onQueryChange={setPaletteQuery}
        onNavigate={push}
      />
    </>
  );
}
