"use client";

import { Hairline } from "@/components/primitives/Hairline";
import { GlowOrb } from "@/components/primitives/GlowOrb";
import { rgbOf, rgba } from "@/lib/categories";

export type CollectionCardProps = {
  title: string;
  subtitle?: string;
  category: string;
  count?: number;
  gradient: string;
  onClick?: () => void;
};

function MiniSquare({ x, y, s, rgb }: { x: number; y: number; s: number; rgb: string }) {
  return (
    <rect
      x={x}
      y={y}
      width={s}
      height={s}
      rx={3}
      fill={rgba(rgb, 0.55)}
      stroke={rgba(rgb, 0.8)}
    />
  );
}

export function CollectionCard({
  title,
  subtitle,
  category,
  count = 0,
  gradient,
  onClick,
}: CollectionCardProps) {
  const rgb = rgbOf(category);
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative text-left rounded-[18px] overflow-hidden border border-ink/[0.07] hover:border-ink/20 hover:-translate-y-[3px] active:translate-y-0 active:scale-[0.992] transition-all duration-300 ease-out w-full"
      style={{ minHeight: 210 }}
    >
      <div className="absolute inset-0" style={{ background: "var(--gg-surface)" }} />
      <div
        className="absolute inset-0 opacity-95 group-hover:opacity-100 transition-opacity duration-500"
        style={{ background: gradient }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-[rgba(0,0,0,0.55)] via-transparent to-transparent" />
      <Hairline inset="8%" color="rgba(var(--gg-ink-rgb),0.16)" />
      <div className="absolute top-2 right-2 w-[104px] h-[84px] opacity-85 group-hover:opacity-100 group-hover:-translate-y-0.5 transition-all duration-500 pointer-events-none">
        <GlowOrb className="right-3 top-3 w-16 h-16" rgb={rgb} blur={7} />
        <svg viewBox="0 0 104 84" className="absolute inset-0 w-full h-full" fill="none">
          <MiniSquare x={62} y={24} s={17} rgb={rgb} />
          <MiniSquare x={42} y={38} s={12} rgb={rgb} />
          <MiniSquare x={82} y={42} s={11} rgb={rgb} />
        </svg>
      </div>
      <div className="relative h-full flex flex-col p-5 min-h-[210px]">
        <h3 className="text-[18px] font-[600] tracking-[-0.02em] text-ink leading-[1.15] max-w-[60%]">
          {title}
        </h3>
        <div className="text-[12px] font-[500] mt-1 mb-3" style={{ color: rgba(rgb, 0.9) }}>
          {count} skills
        </div>
        <p className="text-[12.5px] font-[400] text-ink/45 leading-[1.5] line-clamp-2 mt-auto">
          {subtitle}
        </p>
      </div>
    </button>
  );
}
