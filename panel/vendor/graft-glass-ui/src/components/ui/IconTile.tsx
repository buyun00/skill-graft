import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { rgba } from "@/lib/categories";

type IconTileProps = {
  rgb: string;
  children: ReactNode;
  size?: number;
  className?: string;
};

export function IconTile({ rgb, children, size = 32, className }: IconTileProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-[9px] text-[12px] font-[600] shrink-0",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: rgba(rgb, 0.14),
        border: `1px solid ${rgba(rgb, 0.3)}`,
        color: `rgb(${rgb})`,
      }}
    >
      {children}
    </span>
  );
}
