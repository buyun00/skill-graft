import { cn } from "@/lib/cn";

type AvatarProps = {
  name?: string;
  src?: string | null;
  size?: number;
  className?: string;
  online?: boolean;
};

export function Avatar({ name = "?", src, size = 32, className, online }: AvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className={cn("relative inline-flex flex-shrink-0", className)}>
      <span
        className="rounded-full flex items-center justify-center overflow-hidden text-ink/80 font-[550]"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.38),
          background: "rgba(var(--gg-ink-rgb),0.08)",
          border: "1px solid rgba(var(--gg-ink-rgb),0.1)",
        }}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="w-full h-full object-cover" />
        ) : (
          initial
        )}
      </span>
      {online ? (
        <span
          className="absolute bottom-[-1px] right-[-1px] w-2 h-2 rounded-full"
          style={{ background: "rgba(52,211,153,0.9)", boxShadow: "0 0 0 2px var(--gg-page)" }}
        />
      ) : null}
    </span>
  );
}

export function StatusDot({
  color = "rgba(52,211,153,0.9)",
  className,
}: {
  color?: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-block w-2 h-2 rounded-full", className)} style={{ background: color }} />
  );
}

export function Ping({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex h-1.5 w-1.5", className)}>
      <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 animate-ping" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
    </span>
  );
}
