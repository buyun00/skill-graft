"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Overlay } from "@/components/ui/Overlay";
import { IconButton } from "@/components/ui/IconButton";
import { IconClose } from "@/components/icons";

type SheetProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
};

export function Sheet({ open, onClose, title, children, footer, className }: SheetProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <Overlay onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "absolute top-0 right-0 bottom-0 w-full sm:w-[420px] bg-surface border-l border-ink/10 flex flex-col",
          className,
        )}
        style={{ animation: "modalIn 0.3s cubic-bezier(0.16, 1, 0.3, 1)" }}
      >
        <div className="flex items-center justify-between p-5 border-b border-ink/5">
          <h2 className="text-[17px] font-[600] text-ink">{title}</h2>
          <IconButton aria-label="Close" onClick={onClose}>
            <IconClose size={14} />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto p-5 preview-scroll">{children}</div>
        {footer ? <div className="p-5 border-t border-ink/5">{footer}</div> : null}
      </div>
    </div>
  );
}
