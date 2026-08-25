import { cn } from "@/lib/cn";

export type HubStatus = "ok" | "warn" | "off";

const TONE: Record<HubStatus, string> = {
  ok: "text-emerald-600",
  warn: "text-orange-500",
  off: "text-ink/35",
};

const DOT: Record<HubStatus, string> = {
  ok: "bg-emerald-500",
  warn: "bg-orange-500",
  off: "bg-ink/25",
};

export function StatusPill({
  status,
  label,
  className,
}: {
  status: HubStatus;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] font-[500]", TONE[status], className)}>
      <span className={cn("w-1.5 h-1.5 rounded-full", DOT[status])} />
      {label}
    </span>
  );
}
