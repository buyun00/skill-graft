"use client";

import type { ReactNode } from "react";
import {
  IconBag,
  IconCart,
  IconExplore,
  IconHeart,
  IconSkills,
} from "@/components/icons";
import { Logo } from "@/components/ui/Logo";
import { CreatorCard } from "@/components/ui/CreatorCard";
import { SearchTrigger } from "@/components/ui/SearchTrigger";
import { NavItem } from "@/components/ui/NavItem";
import { AuthCard, type AuthUser } from "@/components/ui/AuthCard";
import { CountBadge } from "@/components/ui/Badge";

export type SidebarNavId = "explore" | "skills" | "favourites" | "cart" | "purchases";

const DEFAULT_NAV: { id: SidebarNavId; label: string; icon: ReactNode }[] = [
  { id: "explore", label: "Explore", icon: <IconExplore size={15} /> },
  { id: "skills", label: "My Skills", icon: <IconSkills size={15} /> },
  { id: "favourites", label: "Favourites", icon: <IconHeart size={15} /> },
  { id: "cart", label: "Cart", icon: <IconCart size={15} /> },
  { id: "purchases", label: "Purchases", icon: <IconBag size={15} /> },
];

type SidebarProps = {
  active?: SidebarNavId;
  cartCount?: number;
  user?: AuthUser | null;
  onSearch?: () => void;
  onNavigate?: (id: SidebarNavId) => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
  contained?: boolean;
};

export function Sidebar({
  active = "explore",
  cartCount = 0,
  user = null,
  onSearch,
  onNavigate,
  onSignIn,
  onSignOut,
  contained,
}: SidebarProps) {
  return (
    <aside
      className={`${contained ? "absolute" : "fixed"} left-0 top-0 bottom-0 z-40 hidden md:flex w-[260px] flex-col`}
      style={{
        background: "var(--gg-sidebar)",
        backdropFilter: "blur(22px)",
        WebkitBackdropFilter: "blur(22px)",
        borderRight: "1px solid rgba(var(--gg-line-rgb), var(--gg-line-alpha))",
      }}
    >
      <div className="relative flex flex-col h-full">
        <div className="px-5 pt-5 pb-3">
          <a href="#top" className="inline-block">
            <Logo />
          </a>
        </div>
        <div className="px-4 pb-5">
          <CreatorCard />
        </div>
        <div className="px-4 pb-9">
          <SearchTrigger onClick={onSearch} />
        </div>
        <nav className="px-3 space-y-0.5 flex-1">
          {DEFAULT_NAV.map((item) => (
            <NavItem
              key={item.id}
              icon={item.icon}
              label={item.label}
              active={active === item.id}
              onClick={() => onNavigate?.(item.id)}
              badge={
                item.id === "cart" && cartCount > 0 ? (
                  <CountBadge>{cartCount}</CountBadge>
                ) : null
              }
            />
          ))}
        </nav>
        <div className="px-3 pb-4">
          <AuthCard user={user} onSignIn={onSignIn} onSignOut={onSignOut} />
        </div>
      </div>
    </aside>
  );
}
