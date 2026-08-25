"use client";

import type { ReactNode } from "react";
import { IconCart, IconExplore, IconPlus, IconSkills } from "@/components/icons";
import { CountBadge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import type { SidebarNavId } from "@/components/blocks/Sidebar";

type MobileTabBarProps = {
  active?: SidebarNavId;
  cartCount?: number;
  onNavigate?: (id: SidebarNavId) => void;
  contained?: boolean;
};

const TABS: { id: SidebarNavId; label: string; icon: ReactNode }[] = [
  { id: "explore", label: "Explore", icon: <IconExplore size={16} /> },
  { id: "skills", label: "My Skills", icon: <IconSkills size={16} /> },
  { id: "cart", label: "Cart", icon: <IconCart size={16} /> },
  { id: "purchases", label: "Publish", icon: <IconPlus size={16} /> },
];

export function MobileTabBar({
  active = "explore",
  cartCount = 0,
  onNavigate,
  contained,
}: MobileTabBarProps) {
  return (
    <nav
      className={`${contained ? "absolute" : "fixed"} bottom-0 left-0 right-0 z-40 md:hidden border-t border-ink/[0.06] backdrop-blur-[20px]`}
      style={{ background: "var(--gg-sidebar)" }}
    >
      <div className="flex items-center justify-around px-3 py-2.5">
        {TABS.map((tab) => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onNavigate?.(tab.id)}
              className="group flex flex-col items-center gap-1 flex-1 min-w-0 px-1 py-1 transition-colors"
            >
              <span className="relative">
                <span className={cn("block", isActive ? "text-ink" : "text-ink/40")}>{tab.icon}</span>
                {tab.id === "cart" && cartCount > 0 ? (
                  <CountBadge
                    tone="solid"
                    className="absolute -top-1.5 -right-1.5"
                  >
                    {cartCount}
                  </CountBadge>
                ) : null}
              </span>
              <span
                className={cn(
                  "text-[10px] font-[450] truncate w-full text-center",
                  isActive ? "text-ink" : "text-ink/40",
                )}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
