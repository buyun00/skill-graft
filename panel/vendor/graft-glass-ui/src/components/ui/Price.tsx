import { cn } from "@/lib/cn";

export function Price({
  amount,
  className,
  size = "md",
}: {
  amount: number;
  className?: string;
  size?: "sm" | "md";
}) {
  const free = amount <= 0;
  return (
    <span className={cn("inline-flex items-baseline gap-1", className)}>
      <span
        className={
          size === "sm"
            ? "text-[13px] font-[600] text-ink"
            : "text-[18px] font-[600] text-ink tracking-[-0.02em]"
        }
      >
        {free ? "Free" : amount}
      </span>
      {!free ? <span className="text-[11px] text-ink/30">SOL</span> : null}
    </span>
  );
}
