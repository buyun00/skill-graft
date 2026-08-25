"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconSpinner } from "@/components/icons";

export type ButtonVariant = "primary" | "secondary" | "glass" | "accent" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-ink text-page hover:opacity-[0.88] hover:-translate-y-[1px] active:opacity-[0.78] active:translate-y-0",
  secondary: "bg-transparent text-ink/65 hover:text-ink",
  glass:
    "bg-ink/[0.06] border border-ink/10 backdrop-blur-[12px] shadow-[inset_0_1px_0_rgba(var(--gg-ink-rgb),0.05)] hover:bg-ink/10",
  accent:
    "shadow-[0_8px_24px_-8px_rgba(var(--gg-accent-rgb),0.6)] hover:brightness-110 active:scale-[0.97]",
  ghost: "bg-transparent text-ink/45 hover:text-ink/85 hover:bg-ink/5",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-4 py-2 text-[13px]",
  md: "px-6 py-[10px] text-[15px]",
  lg: "px-8 py-[14px] text-[15px]",
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading,
    disabled,
    icon,
    className,
    children,
    style,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2",
        "rounded-xl font-[550] transition-all duration-200",
        "cursor-pointer select-none",
        "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 focus-visible:ring-offset-2 focus-visible:ring-offset-page",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      style={
        variant === "accent"
          ? {
              background: "linear-gradient(180deg, var(--gg-accent-hi), var(--gg-accent-lo))",
              color: "var(--gg-on-accent)",
              ...style,
            }
          : style
      }
      {...props}
    >
      {loading ? (
        <IconSpinner size={16} className="animate-spin" />
      ) : icon ? (
        <span className="flex-shrink-0">{icon}</span>
      ) : null}
      {children}
    </button>
  );
});
