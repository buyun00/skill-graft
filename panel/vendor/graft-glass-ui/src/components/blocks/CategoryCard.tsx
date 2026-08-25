"use client";

import type { ReactNode } from "react";
import { rgbOf, rgba } from "@/lib/categories";
import { Hairline } from "@/components/primitives/Hairline";

export type CategoryCardProps = {
  name: string;
  slug: string;
  count?: number;
  icon?: ReactNode;
  onClick?: (slug: string) => void;
};

export function CategoryCard({ name, slug, count = 0, icon, onClick }: CategoryCardProps) {
  const rgb = rgbOf(slug);
  return (
    <button
      type="button"
      onClick={() => onClick?.(slug)}
      className="snap-start shrink-0 w-[182px] group relative rounded-2xl overflow-hidden border border-ink/[0.07] hover:border-ink/20 hover:-translate-y-[2px] active:translate-y-0 transition-all duration-300 text-left"
    >
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(135deg, ${rgba(rgb, 0.14)}, ${rgba(rgb, 0.03)} 60%, transparent)`,
        }}
      />
      <Hairline inset="10%" />
      <div className="relative flex items-center gap-3 p-3.5">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: rgba(rgb, 0.14), border: `1px solid ${rgba(rgb, 0.28)}` }}
        >
          {icon ?? <span className="text-[14px] font-[600]" style={{ color: `rgb(${rgb})` }}>{name[0]}</span>}
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-[600] text-ink capitalize leading-tight">{name}</div>
          <div className="text-[12px] text-ink/40 mt-0.5">{count} skills</div>
        </div>
      </div>
    </button>
  );
}
