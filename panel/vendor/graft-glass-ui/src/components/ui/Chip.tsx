"use client";

import { cn } from "@/lib/cn";

type ChipProps = {
  children: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
};

export function Chip({ children, selected, onClick, className }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 rounded-md text-[12px] font-[400] transition-all duration-200",
        selected ? "text-ink/60 bg-ink/[0.06]" : "text-ink/55 hover:text-ink/80",
        className,
      )}
    >
      {children}
    </button>
  );
}
