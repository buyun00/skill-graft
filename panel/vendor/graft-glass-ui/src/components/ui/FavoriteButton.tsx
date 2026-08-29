"use client";

import { IconHeart } from "@/components/icons";
import { cn } from "@/lib/cn";

type FavoriteButtonProps = {
  active?: boolean;
  onToggle?: () => void;
  className?: string;
};

export function FavoriteButton({ active, onToggle, className }: FavoriteButtonProps) {
  return (
    <button
      type="button"
      aria-label={active ? "Remove from favourites" : "Add to favourites"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle?.();
      }}
      className={cn(
        "relative z-10 transition-colors duration-200",
        active
          ? "text-[rgba(255,100,150,0.9)]"
          : "text-ink/20 group-hover:text-ink/40 hover:!text-[rgba(255,100,150,0.9)]",
        className,
      )}
    >
      <IconHeart size={16} filled={active} />
    </button>
  );
}
