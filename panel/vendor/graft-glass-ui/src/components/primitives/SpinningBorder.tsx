import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type SpinningBorderProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  tone?: "ink" | "accent" | "motion";
  duration?: number;
  radius?: number;
  innerBg?: string;
};

function conic(tone: "ink" | "accent" | "motion"): string {
  if (tone === "accent") {
    return "conic-gradient(from 0deg, transparent 6%, rgba(var(--gg-accent-rgb),0.35) 18%, rgba(var(--gg-accent-rgb),0.9) 30%, rgba(var(--gg-motion-rgb),0.7) 42%, transparent 56%)";
  }
  if (tone === "motion") {
    return "conic-gradient(from 0deg, transparent 6%, rgba(var(--gg-motion-rgb),0.35) 18%, rgba(var(--gg-motion-rgb),0.9) 30%, rgba(var(--gg-accent-rgb),0.55) 42%, transparent 56%)";
  }
  return "conic-gradient(from 0deg, transparent 0%, rgba(var(--gg-ink-rgb),0.25) 8%, rgba(var(--gg-ink-rgb),0.55) 18%, rgba(var(--gg-ink-rgb),0.8) 28%, rgba(var(--gg-ink-rgb),0.55) 38%, rgba(var(--gg-ink-rgb),0.25) 48%, transparent 56%, rgba(var(--gg-ink-rgb),0.2) 72%, rgba(var(--gg-ink-rgb),0.4) 80%, rgba(var(--gg-ink-rgb),0.2) 88%, transparent 100%)";
}

export function SpinningBorder({
  children,
  className,
  tone = "ink",
  duration = 9,
  radius = 14,
  innerBg = "var(--gg-page)",
  ...props
}: SpinningBorderProps) {
  return (
    <div className={cn("relative", className)} style={{ borderRadius: radius }} {...props}>
      <div
        className="absolute inset-0 overflow-hidden pointer-events-none"
        style={{ borderRadius: radius }}
      >
        <div
          className="absolute inset-[-50%] w-[200%] h-[200%] origin-center"
          style={{
            background: conic(tone),
            animation: `borderSpin ${duration}s linear infinite`,
          }}
        />
        <div
          className="absolute inset-[1px]"
          style={{ background: innerBg, borderRadius: Math.max(radius - 1, 0) }}
        />
      </div>
      <div className="relative">{children}</div>
    </div>
  );
}
