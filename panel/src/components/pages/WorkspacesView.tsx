"use client";

import { Button, SectionHeader, StatusPill } from "graft-glass-ui/src/components";
import { WorkspaceOperations } from "./WorkspaceOperations";

type Workspace = {
  id: string;
  name: string;
  path?: string;
  attached?: boolean;
  overrideLinked?: boolean;
  officialPresent?: boolean;
  status: "ok" | "warn" | "off";
  statusLabel: string;
};

type Queued = { id?: string; status?: string; label?: string };

export function WorkspacesView({
  items,
  selectedPath,
  queued,
  busyPath,
  onSelect,
  onAttach,
  onDetach,
}: {
  items: Workspace[];
  selectedPath: string;
  queued: Record<string, Queued>;
  busyPath?: string;
  onSelect: (path: string) => void;
  onAttach: (path: string) => void;
  onDetach: (path: string) => void;
}) {
  return (
    <div>
    <section className="glass p-5 md:p-6 rounded-[22px]">
      <SectionHeader title="工作区" description="typed listWorktrees · attach/detach 是 Application 会话" />
      <div className="space-y-2">
        {items.length === 0 ? <p className="text-[13.5px] text-ink/45">没有工作树。</p> : null}
        {items.map((item) => {
          const path = item.path || item.id;
          const active = path === selectedPath;
          const session = queued[path];
          const busy = busyPath === path;
          return (
            <div
              key={path}
              className={`rounded-2xl px-3 py-3 ${active ? "bg-ink/[0.06]" : "hover:bg-ink/[0.03]"}`}
            >
              <button type="button" className="w-full text-left" onClick={() => onSelect(path)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[14px] font-[600] text-ink">{item.name}</span>
                  <StatusPill status={item.status} label={item.statusLabel} />
                </div>
                <p className="text-[12px] text-ink/40 break-all mt-1">{path}</p>
                <p className="text-[12px] text-ink/45 mt-1 font-mono">
                  attached={String(item.attached)} · overrideLinked={String(item.overrideLinked)} ·
                  officialPresent={String(item.officialPresent)}
                </p>
              </button>
              {session && session.label ? (
                <p className="text-[12.5px] text-emerald-600 mt-2">
                  {session.label}
                  {session.id ? ` · ${session.id}` : ""}
                  {session.status ? ` · ${session.status}` : ""}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2 mt-3">
                <Button size="sm" variant="accent" loading={busy} onClick={() => onAttach(path)}>
                  连接工作区
                </Button>
                <Button size="sm" variant="glass" loading={busy} onClick={() => onDetach(path)}>
                  断开
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
    {selectedPath ? <WorkspaceOperations worktree={selectedPath} /> : null}
    </div>
  );
}
