import { cn } from "@/lib/cn";

type SkeletonProps = {
  className?: string;
  shimmer?: boolean;
  delay?: number;
};

export function Skeleton({ className, shimmer, delay = 0 }: SkeletonProps) {
  if (shimmer) {
    return (
      <div
        className={cn("rounded-xl", className)}
        style={{
          background:
            "linear-gradient(90deg, rgba(var(--gg-ink-rgb),0.035) 0%, rgba(var(--gg-ink-rgb),0.08) 50%, rgba(var(--gg-ink-rgb),0.035) 100%)",
          backgroundSize: "220% 100%",
          animation: `shimmer 2.8s ease-in-out ${delay}s infinite`,
        }}
      />
    );
  }
  return (
    <div
      className={cn(
        "animate-pulse rounded-xl bg-ink/[0.04]",
        className,
      )}
    />
  );
}

export function Spinner({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg className={cn("animate-spin", className)} width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
