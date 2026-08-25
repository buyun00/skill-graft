"use client";

import { cn } from "@/lib/cn";

export function Overlay({
  onClick,
  className,
}: {
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 backdrop-blur-sm",
        className,
      )}
      style={{ animation: "backdropIn 0.15s ease-out", background: "var(--gg-overlay)" }}
      onClick={onClick}
    />
  );
}
