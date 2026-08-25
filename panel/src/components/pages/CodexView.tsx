"use client";

import { useEffect, useRef, useState } from "react";
import { Button, SectionHeader, StatusPill } from "graft-glass-ui/src/components";
import { panelApi } from "../../../lib/api.mjs";

type Session = {
  id: string;
  kind?: string;
  status?: string;
  intent?: string;
  worktree?: string;
  lastMessage?: string;
  canResume?: boolean;
  capabilities?: {
    canResume?: boolean;
    canCancel?: boolean;
  };
  steps?: SessionStep[];
  events?: SessionEvent[];
};

type SessionStep = {
  id?: string;
  title?: string;
  owner?: string;
  status?: string;
  at?: string;
};

type SessionEvent = {
  sequence?: number;
  type?: string;
  at?: string;
  stepId?: string;
  status?: string;
  code?: string;
};

export function CodexView({
  sessions,
  selectedId,
  busy,
  onSelect,
  onStart,
  onResume,
  onCancel,
}: {
  sessions: Session[];
  selectedId: string;
  busy?: boolean;
  onSelect: (id: string) => void;
  onStart: (body: { kind?: string; intent?: string; worktree?: string }) => void;
  onResume: (id: string, message: string) => void;
  onCancel: (id: string) => void;
}) {
  const [intent, setIntent] = useState("");
  const [message, setMessage] = useState("");
  const [log, setLog] = useState("");
  const [streamStatus, setStreamStatus] = useState("");
  const [liveSession, setLiveSession] = useState<Session | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!selectedId) {
      setLog("");
      setStreamStatus("");
      setLiveSession(null);
      return;
    }
    const url = panelApi.sessionStreamUrl(selectedId);
    const source = new EventSource(url);
    let terminal = false;
    setLog("");
    setStreamStatus("connecting");
    setLiveSession(null);
    source.addEventListener("session", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        if (data && typeof data === "object") setLiveSession(data as Session);
      } catch {
        // The next typed session event or list refresh remains authoritative.
      }
    });
    source.addEventListener("log", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        setLog(data.text || "");
      } catch {
        setLog((event as MessageEvent).data || "");
      }
    });
    source.addEventListener("status", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        setStreamStatus(data.status || "status");
      } catch {
        setStreamStatus((event as MessageEvent).data || "status");
      }
    });
    source.addEventListener("end", (event) => {
      terminal = true;
      try {
        const data = JSON.parse((event as MessageEvent).data);
        setStreamStatus(data.reason ? `ended: ${data.reason}` : "ended");
      } catch {
        setStreamStatus("ended");
      }
      source.close();
    });
    source.onerror = () => {
      if (!terminal) setStreamStatus((prev) => prev || "error");
    };
    return () => source.close();
  }, [selectedId]);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [log]);

  const selectedFromList = sessions.find((item) => item.id === selectedId) || null;
  const selected = liveSession?.id === selectedId ? liveSession : selectedFromList;
  const canResume = selected?.capabilities?.canResume ?? selected?.canResume ?? false;
  const canCancel = selected?.capabilities?.canCancel ?? false;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[300px_1fr] gap-4">
      <section className="glass p-4 rounded-[22px]">
        <SectionHeader title="会话" description="GET /api/codex/sessions" />
        <div className="space-y-3 mb-4">
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="新对话意图"
            className="w-full min-h-[72px] px-3 py-2 rounded-xl bg-ink/[0.03] border border-ink/[0.06] text-[13px] text-ink"
          />
          <Button size="sm" variant="accent" loading={busy} onClick={() => onStart({ kind: "chat", intent })}>
            开始对话
          </Button>
        </div>
        <div className="space-y-1">
          {sessions.length === 0 ? <p className="text-[12.5px] text-ink/40">没有会话。</p> : null}
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelect(session.id)}
              className={`w-full text-left px-3 py-2.5 rounded-xl ${
                session.id === selectedId ? "bg-ink/[0.06]" : "hover:bg-ink/[0.04]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-[550] text-ink truncate">{session.kind || "session"}</span>
                <StatusPill
                  status={session.status === "running" || session.status === "awaiting" ? "warn" : session.status === "failed" ? "off" : "ok"}
                  label={session.status || "unknown"}
                />
              </div>
              <div className="text-[11px] text-ink/40 truncate">{session.id}</div>
            </button>
          ))}
        </div>
      </section>
      <section className="glass p-5 rounded-[22px]">
        <SectionHeader
          title={selected ? `${selected.kind || "session"} ${selected.id}` : "Codex 日志"}
          description="SSE session/status/end；步骤与事件来自 typed SessionView"
        />
        {selected ? (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="继续说…"
              className="flex-1 min-w-[180px] px-3 py-2 rounded-xl bg-ink/[0.03] border border-ink/[0.06] text-[13px] text-ink"
            />
            <Button
              size="sm"
              variant="glass"
              disabled={!canResume || !message.trim()}
              loading={busy}
              onClick={() => onResume(selected.id, message)}
            >
              resume
            </Button>
            <Button
              size="sm"
              variant="glass"
              disabled={!canCancel}
              loading={busy}
              onClick={() => onCancel(selected.id)}
            >
              cancel
            </Button>
            <span className="text-[12px] text-ink/40">{streamStatus}</span>
          </div>
        ) : (
          <p className="text-[13.5px] text-ink/45 mb-3">选择或开始一个会话。</p>
        )}
        {selected ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
            <div className="rounded-xl bg-ink/[0.03] p-3">
              <p className="text-[12px] font-[600] text-ink/65 mb-2">真实步骤</p>
              <div className="space-y-2">
                {(selected.steps || []).map((step, index) => (
                  <div key={step.id || `step-${index}`} className="text-[12px] text-ink/70">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono break-all">{step.title || step.id || `step ${index + 1}`}</span>
                      <span className="text-ink/45">{step.status || "unknown"}</span>
                    </div>
                    {step.owner || step.at ? (
                      <p className="text-ink/45 break-words">{[step.owner, step.at].filter(Boolean).join(" · ")}</p>
                    ) : null}
                  </div>
                ))}
                {(selected.steps || []).length === 0 ? (
                  <p className="text-[12px] text-ink/40">尚无步骤事件。</p>
                ) : null}
              </div>
            </div>
            <div className="rounded-xl bg-ink/[0.03] p-3">
              <p className="text-[12px] font-[600] text-ink/65 mb-2">会话事件</p>
              <div className="space-y-2 max-h-48 overflow-auto">
                {(selected.events || []).map((event, index) => (
                  <div key={event.sequence || `${event.type || "event"}-${event.at || index}`} className="text-[12px] text-ink/70">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono break-all">{event.type || event.stepId || `event ${index + 1}`}</span>
                      <span className="text-ink/40">{event.at || event.status || ""}</span>
                    </div>
                    {event.code ? (
                      <p className="text-ink/45 break-words">{event.code}</p>
                    ) : null}
                  </div>
                ))}
                {(selected.events || []).length === 0 ? (
                  <p className="text-[12px] text-ink/40">尚无会话事件。</p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        <pre
          ref={preRef}
          className="text-[12px] leading-6 whitespace-pre-wrap break-all text-ink/80 font-mono bg-ink/[0.03] rounded-xl p-3 max-h-[38vh] overflow-auto"
        >
          {log || (selectedId ? "等待 event: session / log / status / end…" : "")}
        </pre>
      </section>
    </div>
  );
}
