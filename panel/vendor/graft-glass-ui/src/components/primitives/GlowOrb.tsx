import { cn } from "@/lib/cn";

type GlowOrbProps = {
  className?: string;
  rgb?: string;
  opacity?: number;
  blur?: number;
};

export function GlowOrb({
  className,
  rgb = "var(--gg-accent-rgb)",
  opacity = 0.32,
  blur = 6,
}: GlowOrbProps) {
  return (
    <span
      className={cn("absolute rounded-full pointer-events-none", className)}
      style={{
        background: `radial-gradient(circle, rgba(${rgb},${opacity}), transparent 70%)`,
        filter: `blur(${blur}px)`,
      }}
    />
  );
}
