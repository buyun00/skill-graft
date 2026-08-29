"use client";

import type { ReactNode } from "react";
import { Sidebar, type SidebarNavId } from "@/components/blocks/Sidebar";
import { MobileTabBar } from "@/components/blocks/MobileTabBar";
import type { AuthUser } from "@/components/ui/AuthCard";

type AppShellProps = {
  children: ReactNode;
  active?: SidebarNavId;
  cartCount?: number;
  user?: AuthUser | null;
  onSearch?: () => void;
  onNavigate?: (id: SidebarNavId) => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
  contained?: boolean;
};

export function AppShell({
  children,
  active,
  cartCount,
  user,
  onSearch,
  onNavigate,
  onSignIn,
  onSignOut,
  contained,
}: AppShellProps) {
  return (
    <div className={contained ? "relative h-full min-h-[760px]" : undefined}>
      <Sidebar
        active={active}
        cartCount={cartCount}
        user={user}
        onSearch={onSearch}
        onNavigate={onNavigate}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
        contained={contained}
      />
      <MobileTabBar
        active={active}
        cartCount={cartCount}
        onNavigate={onNavigate}
        contained={contained}
      />
      <main className="md:ml-[260px] min-h-screen pb-20 md:pb-0">{children}</main>
    </div>
  );
}
