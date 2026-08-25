"use client";

import { Badge } from "@/components/ui/Badge";
import { FavoriteButton } from "@/components/ui/FavoriteButton";
import { Hairline } from "@/components/primitives/Hairline";
import { GlowOrb } from "@/components/primitives/GlowOrb";
import { Price } from "@/components/ui/Price";
import { Rating } from "@/components/ui/Rating";
import { rgbOf } from "@/lib/categories";

export type Skill = {
  id: string;
  title: string;
  description: string;
  category: string;
  priceSol: number;
  version?: string | number;
  avgRating?: number | null;
  reviewCount?: number | null;
  salesCount?: number | null;
  href?: string;
};

type SkillCardProps = {
  skill: Skill;
  favorited?: boolean;
  onFavorite?: (id: string) => void;
};

export function SkillCard({ skill, favorited, onFavorite }: SkillCardProps) {
  const rgb = rgbOf(skill.category);
  return (
    <div className="block h-full">
      <div
        className="group relative h-full rounded-[16px] overflow-hidden border transition-all duration-300 ease-out hover:-translate-y-[3px] active:translate-y-0 active:scale-[0.99] cursor-pointer"
        style={{
          background: "rgba(var(--gg-ink-rgb),0.022)",
          borderColor: "rgba(var(--gg-ink-rgb),0.07)",
        }}
      >
        <a
          href={skill.href ?? `#skill-${skill.id}`}
          aria-label={skill.title}
          className="absolute inset-0 z-0"
        />
        <GlowOrb
          className="-top-10 -right-10 w-40 h-40 opacity-70 group-hover:opacity-100 transition-opacity duration-500"
          rgb={rgb}
          opacity={0.16}
          blur={12}
        />
        <Hairline />
        <div className="relative flex flex-col h-full p-5" style={{ pointerEvents: "none" }}>
          <div className="flex items-center justify-between mb-3.5">
            <div className="flex items-center gap-2 min-w-0">
              <Badge category={skill.category}>{skill.category}</Badge>
              {skill.version ? (
                <span className="text-[10.5px] font-[450] text-ink/30">v{skill.version}</span>
              ) : null}
            </div>
            <span style={{ pointerEvents: "auto" }}>
              <FavoriteButton active={favorited} onToggle={() => onFavorite?.(skill.id)} />
            </span>
          </div>
          <h3 className="text-[16px] font-[600] tracking-[-0.02em] text-ink leading-[1.2] mb-1.5 line-clamp-1">
            {skill.title}
          </h3>
          <p className="text-[12.5px] font-[400] text-ink/45 leading-[1.5] line-clamp-2 mb-3">
            {skill.description}
          </p>
          <Rating
            value={skill.avgRating}
            reviewCount={skill.reviewCount}
            salesCount={skill.salesCount}
            className="mb-4"
          />
          <div className="mt-auto flex items-center justify-between">
            <Price amount={skill.priceSol} />
          </div>
        </div>
      </div>
    </div>
  );
}
