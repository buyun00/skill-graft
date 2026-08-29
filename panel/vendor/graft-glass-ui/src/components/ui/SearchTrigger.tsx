"use client";

import { IconSearch } from "@/components/icons";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/lib/cn";

type SearchTriggerProps = {
  label?: string;
  shortcut?: string;
  onClick?: () => void;
  className?: string;
};

export function SearchTrigger({
  label = "Search skills",
  shortcut = "⌘K",
  onClick,
  className,
}: SearchTriggerProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative w-full flex items-center gap-2.5 px-3.5 py-[11px] rounded-[12px] overflow-hidden transition-all duration-300",
        className,
      )}
      style={{
        background: "rgba(var(--gg-ink-rgb),0.025)",
        border: "1px solid rgba(var(--gg-ink-rgb),0.07)",
      }}
    >
      <span
        className="absolute top-0 left-[12%] right-[12%] h-px pointer-events-none"
        style={{
          background: "linear-gradient(90deg, transparent, rgba(var(--gg-ink-rgb),0.1), transparent)",
        }}
      />
      <span
        className="absolute inset-0 rounded-[12px] pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          background: "rgba(var(--gg-ink-rgb),0.02)",
          border: "1px solid rgba(var(--gg-ink-rgb),0.12)",
        }}
      />
      <span
        className="absolute inset-y-0 w-[35%] pointer-events-none opacity-0 group-hover:opacity-100 left-0"
        style={{
          background: "linear-gradient(90deg, transparent, rgba(var(--gg-ink-rgb),0.06), transparent)",
          animation: "searchShimmer 1.2s ease-in-out",
        }}
      />
      <span className="relative text-ink/35 group-hover:text-ink/60 transition-colors duration-200">
        <IconSearch size={14} />
      </span>
      <span className="relative flex-1 text-left text-[13px] font-[400] text-ink/40 group-hover:text-ink/60 transition-colors duration-200 tracking-[-0.01em]">
        {label}
      </span>
      <Kbd className="relative group-hover:text-ink/60 transition-colors duration-200">{shortcut}</Kbd>
    </button>
  );
}
