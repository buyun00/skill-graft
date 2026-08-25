import { cn } from "@/lib/cn";

type LogoProps = {
  size?: "sm" | "md" | "lg";
  showText?: boolean;
  className?: string;
};

const SIZE = { sm: 16, md: 20, lg: 24 } as const;
const GAP = { sm: 1.5, md: 2, lg: 2 } as const;

export function Logo({ size = "md", showText = true, className }: LogoProps) {
  const s = SIZE[size];
  const n = GAP[size];
  const cell = (s - n) / 2;

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
        <rect x={0} y={0} width={cell} height={cell} rx={2} fill="rgb(var(--gg-accent-rgb))" opacity={0.9} />
        <rect x={cell + n} y={0} width={cell} height={cell} rx={2} fill="rgb(var(--gg-accent-rgb))" opacity={0.5} />
        <rect x={0} y={cell + n} width={cell} height={cell} rx={2} fill="rgb(var(--gg-accent-rgb))" opacity={0.5} />
        <rect
          x={cell + n}
          y={cell + n}
          width={cell}
          height={cell}
          rx={2}
          fill="rgb(var(--gg-accent-rgb))"
          opacity={0.25}
        />
      </svg>
      {showText ? <span className="text-nav-brand">GRAFT</span> : null}
    </div>
  );
}
