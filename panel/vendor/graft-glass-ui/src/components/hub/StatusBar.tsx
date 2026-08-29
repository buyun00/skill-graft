"use client";

import { IconCube, IconDrive, IconFolder, IconGit, IconRefresh, IconSparkle } from "@/components/icons";
import { StatusPill, type HubStatus } from "@/components/hub/StatusPill";

export function StatusBar({
  librarySkillCount,
  connectedSkillCount,
  git = { status: "warn", label: "检测中" },
  repository = { status: "warn", label: "读取中" },
  codex = { status: "warn", label: "检测中" },
  storage = "本机 hub",
  onRefresh,
}: {
  librarySkillCount?: number;
  connectedSkillCount?: number;
  git?: { status: HubStatus; label: string };
  repository?: { status: HubStatus; label: string };
  codex?: { status: HubStatus; label: string };
  storage?: string;
  onRefresh?: () => void;
}) {
  return (
    <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1 pt-3 text-[12.5px] text-ink/50">
      <span className="inline-flex items-center gap-1.5">
        <IconCube size={14} />
        技能库内容
        <span className="text-ink/60">
          {typeof librarySkillCount === "number" ? `${librarySkillCount} 个 Skill` : "加载中"}
        </span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <IconFolder size={14} />
        工作树已连接 Skill
        <span className="text-ink/60">
          {typeof connectedSkillCount === "number" ? `${connectedSkillCount} 个` : "加载中"}
        </span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <IconGit size={14} />
        Git 可用性
        <StatusPill status={git.status} label={git.label} />
      </span>
      <span className="inline-flex items-center gap-1.5">
        <IconFolder size={14} />
        当前仓库
        <StatusPill status={repository.status} label={repository.label} />
      </span>
      <span className="inline-flex items-center gap-1.5">
        <IconSparkle size={14} />
        Codex Runner
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
