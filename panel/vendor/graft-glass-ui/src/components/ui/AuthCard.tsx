"use client";

import { IconSignOut, IconUser } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";

export type AuthUser = {
  name: string;
  subtitle?: string;
  avatarUrl?: string | null;
};

type AuthCardProps = {
  user?: AuthUser | null;
  onSignIn?: () => void;
  onSignOut?: () => void;
  className?: string;
};

export function AuthCard({ user, onSignIn, onSignOut, className }: AuthCardProps) {
  if (!user) {
    return (
      <button
        type="button"
        onClick={onSignIn}
        className={cn(
          "group relative flex items-center gap-3 mt-2 px-3 py-2.5 rounded-[12px] overflow-hidden transition-all duration-200 w-full text-left",
          "hover:border-ink/20",
          className,
        )}
        style={{ border: "1px solid rgba(var(--gg-ink-rgb),0.07)" }}
      >
        <span className="relative w-8 h-8 rounded-full flex items-center justify-center bg-ink/[0.04] text-ink/40">
          <IconUser size={15} />
        </span>
        <span className="relative min-w-0 flex-1">
          <span className="block text-ink text-[14px] font-[500] truncate">Sign in</span>
          <span className="block truncate mt-[2px] text-[11px] text-ink/40">
            Create account or log in
          </span>
        </span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 mt-2 px-3 py-2.5 rounded-[12px] overflow-hidden",
        className,
      )}
      style={{ border: "1px solid rgba(255,255,255,0.07)" }}
    >
      <Avatar name={user.name} src={user.avatarUrl} online />
      <div className="relative min-w-0 flex-1 pointer-events-none">
        <div className="text-ink text-[14px] font-[500] truncate">{user.name}</div>
        {user.subtitle ? (
          <div className="truncate mt-[2px] text-[11px] text-ink/40">{user.subtitle}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onSignOut}
        aria-label="Sign out"
        className="relative z-10 w-7 h-7 rounded-lg flex items-center justify-center text-ink/30 hover:text-ink/70 hover:bg-ink/5 transition-all"
      >
        <IconSignOut size={13} />
      </button>
    </div>
  );
}
