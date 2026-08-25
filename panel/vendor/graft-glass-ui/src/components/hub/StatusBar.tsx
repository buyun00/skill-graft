"use client";

import { IconDrive, IconGit, IconRefresh, IconSparkle } from "@/components/icons";
import { StatusPill, type HubStatus } from "@/components/hub/StatusPill";

export function StatusBar({
  git = { status: "ok", label: "正常" },
  codex = { status: "ok", label: "正常" },
  storage = "125.3 GB 可用",
  onRefresh,
}: {
  git?: { status: HubStatus; label: string };
  codex?: { status: HubStatus; label: string };
  storage?: string;
  onRefresh?: () => void;
}) {
  return (
    <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1 pt-3 text-[12.5px] text-ink/50">
      <span className="inline-flex items-center gap-1.5">
        <IconGit size={14} />
        Git 连接
        <StatusPill status={git.status} label={git.label} />
      </span>
      <span className="inline-flex items-center gap-1.5">
        <IconSparkle size={14} />
        Codex 服务
        <StatusPill status={codex.status} label={codex.label} />
      </span>
      <span className="inline-flex items-center gap-1.5">
        <IconDrive size={14} />
        本地存储
        <span className="text-ink/60">{storage}</span>
      </span>
      <button
        type="button"
        onClick={onRefresh}
        className="ml-auto inline-flex items-center gap-1.5 text-ink/40 hover:text-ink transition-colors"
      >
        <IconRefresh size={13} />
        最后同步 刷新
      </button>
    </footer>
  );
}
