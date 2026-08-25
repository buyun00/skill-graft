import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type EmptyAction = {
  label: string;
  href?: string;
  onClick?: () => void;
};

function EmptyActionButton({
  action,
  variant,
}: {
  action: EmptyAction;
  variant: "primary" | "ghost";
}) {
  const className =
    variant === "primary"
      ? "inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-[14px] font-[600] shadow-[0_8px_24px_-8px_rgba(var(--gg-accent-rgb),0.6)] hover:brightness-110 active:scale-[0.97] transition-all duration-200"
      : "inline-flex items-center justify-center px-5 py-2.5 rounded-xl text-[14px] font-[400] text-ink/40 hover:text-ink/70 transition-colors duration-200";
  const style =
    variant === "primary"
      ? {
          background: "linear-gradient(180deg, var(--gg-accent-hi), var(--gg-accent-lo))",
          color: "var(--gg-on-accent)",
        }
      : undefined;

  if (action.href) {
    return (
      <a href={action.href} className={className} style={style}>
        {action.label}
      </a>
    );
  }
  return (
    <button type="button" onClick={action.onClick} className={className} style={style}>
      {action.label}
    </button>
  );
}

type EmptyStateProps = {
  icon: ReactNode;
  title: string;
  description?: string;
  primary?: EmptyAction;
  secondary?: EmptyAction;
  className?: string;
};

export function EmptyState({
  icon,
  title,
  description,
  primary,
  secondary,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center text-center py-16 md:py-20", className)}>
      <div className="relative mb-6">
        <div
          className="absolute inset-0 rounded-full blur-2xl animate-emptyOrb"
          style={{
            background: "radial-gradient(circle, rgba(var(--gg-accent-rgb),0.3), transparent 70%)",
          }}
        />
        <div className="relative w-14 h-14 rounded-2xl bg-accent/[0.07] border border-accent/20 flex items-center justify-center text-accent">
          {icon}
        </div>
      </div>
      <h2 className="text-[22px] font-[600] tracking-[-0.015em] text-ink mb-2">{title}</h2>
      {description ? (
        <p className="text-[15px] font-[400] leading-[1.65] text-ink/45 max-w-[380px] mb-7">
          {description}
        </p>
      ) : null}
      {primary || secondary ? (
        <div className="flex items-center gap-2">
          {primary ? <EmptyActionButton action={primary} variant="primary" /> : null}
          {secondary ? <EmptyActionButton action={secondary} variant="ghost" /> : null}
        </div>
      ) : null}
    </div>
  );
}
