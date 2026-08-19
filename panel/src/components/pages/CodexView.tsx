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
};

export function CodexView({
  sessions,
  selectedId,
  busy,
  onSelect,
  onStart,
  onResume,
}: {
  sessions: Session[];
  selectedId: string;
  busy?: boolean;
  onSelect: (id: string) => void;
  onStart: (body: { kind?: string; intent?: string; worktree?: string }) => void;
  onResume: (id: string, message: string) => void;
}) {
  const [intent, setIntent] = useState("");
  const [message, setMessage] = useState("");
  const [log, setLog] = useState("");
  const [streamStatus, setStreamStatus] = useState("");
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!selectedId) {
      setLog("");
      setStreamStatus("");
      return;
    }
    const url = panelApi.sessionStreamUrl(selectedId);
    const source = new EventSource(url);
    setLog("");
    setStreamStatus("connecting");
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
    source.onerror = () => {
      setStreamStatus((prev) => prev || "error");
    };
    return () => source.close();
  }, [selectedId]);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [log]);

  const selected = sessions.find((item) => item.id === selectedId) || null;

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
                  status={session.status === "running" ? "warn" : session.status === "failed" ? "off" : "ok"}
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
          description="EventSource /api/codex/session/stream?id="
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
              disabled={!selected.canResume && selected.status === "running"}
              loading={busy}
              onClick={() => onResume(selected.id, message)}
            >
              resume
            </Button>
            <span className="text-[12px] text-ink/40">{streamStatus}</span>
          </div>
        ) : (
          <p className="text-[13.5px] text-ink/45 mb-3">选择或开始一个会话。</p>
        )}
        <pre
          ref={preRef}
          className="text-[12px] leading-6 whitespace-pre-wrap break-all text-ink/80 font-mono bg-ink/[0.03] rounded-xl p-3 max-h-[55vh] overflow-auto"
        >
          {log || (selectedId ? "等待 event: log / event: status…" : "")}
        </pre>
      </section>
    </div>
  );
}
