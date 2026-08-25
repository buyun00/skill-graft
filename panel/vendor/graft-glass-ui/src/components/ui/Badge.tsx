import { cn } from "@/lib/cn";
import { rgbOf, rgba } from "@/lib/categories";

type BadgeProps = {
  children: React.ReactNode;
  category?: string;
  rgb?: string;
  className?: string;
};

export function Badge({ children, category, rgb, className }: BadgeProps) {
  const color = rgb ?? rgbOf(category);
  return (
    <span
      className={cn(
        "px-2.5 py-1 rounded-md text-[10.5px] font-[550] capitalize truncate",
        className,
      )}
      style={{
        background: rgba(color, 0.12),
        border: `1px solid ${rgba(color, 0.2)}`,
        color: rgba(color, 0.95),
      }}
    >
      {children}
    </span>
  );
}

export function CountBadge({
  children,
  tone = "muted",
  className,
}: {
  children: React.ReactNode;
  tone?: "muted" | "solid";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center min-w-[14px] h-[14px] px-1 rounded-full text-[8.5px] font-[500] tabular-nums",
        tone === "solid"
          ? "bg-ink text-page text-[10px] font-[600] min-w-[17px] h-[17px]"
          : "text-ink/55",
        className,
      )}
    >
      {children}
    </span>
  );
}
