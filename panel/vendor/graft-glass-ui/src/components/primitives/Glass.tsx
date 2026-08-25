import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type GlassProps = HTMLAttributes<HTMLDivElement> & {
  radius?: number;
};

export function Glass({ className, radius, style, ...props }: GlassProps) {
  return (
    <div
      className={cn("glass", className)}
      style={radius != null ? { borderRadius: radius, ...style } : style}
      {...props}
    />
  );
}
