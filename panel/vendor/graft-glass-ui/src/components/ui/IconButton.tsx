"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  shape?: "square" | "round";
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, shape = "square", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center w-8 h-8 text-ink/40 hover:text-ink hover:bg-ink/5 transition-all duration-200 active:scale-95",
        shape === "round" ? "rounded-full" : "rounded-lg",
        className,
      )}
      {...props}
    />
  );
});
