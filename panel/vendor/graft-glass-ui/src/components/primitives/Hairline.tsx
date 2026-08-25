import { cn } from "@/lib/cn";

type HairlineProps = {
  className?: string;
  color?: string;
  inset?: string;
};

/** 1px top highlight used on GRAFT cards and nav. */
export function Hairline({
  className,
  color = "rgba(var(--gg-ink-rgb), 0.1)",
  inset = "10%",
}: HairlineProps) {
  return (
    <span
      className={cn("absolute top-0 h-px pointer-events-none", className)}
      style={{
        left: inset,
        right: inset,
        background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
      }}
    />
  );
}
