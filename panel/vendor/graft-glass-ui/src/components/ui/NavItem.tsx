import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { GlowOrb } from "@/components/primitives/GlowOrb";
import { Hairline } from "@/components/primitives/Hairline";

export type NavItemProps = {
  href?: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  badge?: ReactNode;
  onClick?: () => void;
};

export function NavItem({ href = "#", icon, label, active, badge, onClick }: NavItemProps) {
  const className = cn(
    "group relative flex items-center gap-3 pl-3.5 pr-3 py-[11px] rounded-[11px] transition-all duration-200 overflow-hidden",
    !active && "hover:bg-ink/[0.03]",
  );

  const inner = (
    <>
      {active ? (
        <>
          <span
            className="absolute inset-0 rounded-[11px] pointer-events-none"
            style={{
              background:
                "linear-gradient(90deg, rgba(var(--gg-accent-rgb),0.16), rgba(var(--gg-accent-rgb),0.04) 55%, rgba(var(--gg-ink-rgb),0.02))",
              border: "1px solid rgba(var(--gg-accent-rgb),0.22)",
            }}
          />
          <GlowOrb className="-left-6 top-1/2 -translate-y-1/2 w-16 h-16" />
          <Hairline inset="14%" color="rgba(var(--gg-ink-rgb),0.22)" />
          <span
            className="absolute left-0 top-[8px] bottom-[8px] w-[3px] rounded-full pointer-events-none"
            style={{
              background: "rgb(var(--gg-accent-rgb))",
              boxShadow: "0 0 12px 1.5px rgba(var(--gg-accent-rgb),0.8)",
            }}
          />
        </>
      ) : null}
      <span
        className="relative flex items-center justify-center w-4 h-4 flex-shrink-0 transition-colors duration-200"
        style={{ color: active ? "rgb(var(--gg-ink-rgb))" : "rgba(var(--gg-ink-rgb),0.35)" }}
      >
        {icon}
      </span>
      <span
        className={cn(
          "relative flex-1 text-[13.5px] tracking-[-0.01em] transition-colors duration-200",
          active ? "text-ink font-[600]" : "text-ink/50 font-[400] group-hover:text-ink/80",
        )}
      >
        {label}
      </span>
      {badge ? <span className="relative">{badge}</span> : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(className, "w-full text-left")}>
        {inner}
      </button>
    );
  }

  return (
    <a href={href} className={className}>
      {inner}
    </a>
  );
}
