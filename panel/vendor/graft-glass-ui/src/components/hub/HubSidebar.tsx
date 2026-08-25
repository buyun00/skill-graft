"use client";

import type { ReactNode } from "react";
import {
  IconCube,
  IconFolder,
  IconGear,
  IconHome,
  IconRefresh,
  IconSparkle,
  IconStore,
} from "@/components/icons";
import { AuthCard, type AuthUser } from "@/components/ui/AuthCard";
import { CountBadge } from "@/components/ui/Badge";
import { Logo } from "@/components/ui/Logo";
import { NavItem } from "@/components/ui/NavItem";
import { cn } from "@/lib/cn";

export type HubNavId =
  | "overview"
  | "skills"
  | "updates"
  | "workspaces"
  | "store"
  | "codex"
  | "settings";

const NAV: { id: HubNavId; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "总览", icon: <IconHome size={15} /> },
  { id: "skills", label: "技能库", icon: <IconCube size={15} /> },
  { id: "updates", label: "更新中心", icon: <IconRefresh size={15} /> },
  { id: "workspaces", label: "工作区", icon: <IconFolder size={15} /> },
  { id: "store", label: "商店", icon: <IconStore size={15} /> },
  { id: "codex", label: "Codex 助手", icon: <IconSparkle size={15} /> },
  { id: "settings", label: "设置", icon: <IconGear size={15} /> },
];

export function HubSidebar({
  active = "overview",
  updateCount = 0,
  user,
  contained,
  onNavigate,
  onSignOut,
}: {
  active?: HubNavId;
  updateCount?: number;
  user?: AuthUser | null;
  contained?: boolean;
  onNavigate?: (id: HubNavId) => void;
  onSignOut?: () => void;
}) {
  return (
    <aside
      className={cn(
        contained ? "absolute" : "fixed",
        "left-0 top-0 bottom-0 z-40 hidden md:flex w-[240px] flex-col",
      )}
      style={{
        background: "var(--gg-sidebar)",
        backdropFilter: "blur(22px)",
        WebkitBackdropFilter: "blur(22px)",
        borderRight: "1px solid rgba(var(--gg-line-rgb), var(--gg-line-alpha))",
      }}
    >
      <div className="px-5 pt-5 pb-4">
        <Logo showText={false} />
        <div className="mt-3 text-[15px] font-[600] tracking-[-0.03em] text-ink">Skill Hub</div>
        <div className="text-[11px] text-ink/40 mt-0.5">本地技能控制中心</div>
      </div>
      <nav className="px-3 space-y-0.5 flex-1">
        {NAV.map((item) => (
          <NavItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={active === item.id}
            onClick={() => onNavigate?.(item.id)}
            badge={
              item.id === "updates" && updateCount > 0 ? (
                <CountBadge>{updateCount}</CountBadge>
              ) : null
            }
          />
        ))}
      </nav>
      <div className="px-3 pb-4">
        <AuthCard user={user} onSignOut={onSignOut} />
      </div>
    </aside>
  );
}
