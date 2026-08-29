import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function VersionChip({
  from,
  to,
  prefix = "v",
  className,
}: {
  from?: string;
  to?: string;
  prefix?: string;
  className?: string;
}) {
  if (!from && !to) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-[550] bg-violet-500/10 text-violet-600",
        className,
      )}
    >
      {from ? <span>{`${prefix}${from}`}</span> : null}
      {from && to ? <span className="text-violet-400">→</span> : null}
      {to ? <span>{`${prefix}${to}`}</span> : null}
    </span>
  );
}

export function TagChip({
  children,
  tone = "violet",
  className,
}: {
  children: ReactNode;
  tone?: "violet" | "warn" | "ok";
  className?: string;
}) {
  const map = {
    violet: "bg-violet-500/10 text-violet-600",
    warn: "bg-orange-500/10 text-orange-600",
    ok: "bg-emerald-500/10 text-emerald-600",
  };
  return (
    <span className={cn("px-1.5 py-0.5 rounded-md text-[11px] font-[550]", map[tone], className)}>
      {children}
    </span>
  );
}
