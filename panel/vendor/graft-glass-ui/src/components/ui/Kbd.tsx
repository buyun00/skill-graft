import { cn } from "@/lib/cn";

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center px-[7px] py-[2px] rounded-[5px] text-[10px] font-[500] text-ink/40",
        className,
      )}
      style={{ border: "1px solid rgba(var(--gg-ink-rgb),0.08)", letterSpacing: "0.04em" }}
    >
      {children}
    </span>
  );
}
