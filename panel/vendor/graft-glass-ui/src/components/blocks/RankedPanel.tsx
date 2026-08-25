import type { ReactNode } from "react";
import { Hairline } from "@/components/primitives/Hairline";
import { GlowOrb } from "@/components/primitives/GlowOrb";
import { RankedRow, type RankedItem } from "@/components/ui/RankedRow";

type RankedPanelProps = {
  title: string;
  icon?: ReactNode;
  accent?: string;
  ranked?: boolean;
  skills: RankedItem[];
};

export function RankedPanel({
  title,
  icon,
  accent = "var(--gg-accent-rgb)",
  ranked,
  skills,
}: RankedPanelProps) {
  if (!skills.length) return null;
  return (
    <div
      className="relative rounded-2xl overflow-hidden p-5 border"
      style={{
        background: "rgba(var(--gg-ink-rgb),0.018)",
        borderColor: `rgba(${accent},0.2)`,
      }}
    >
      <Hairline inset="8%" color={`rgba(${accent},0.45)`} />
      <GlowOrb className="-top-12 -right-12 w-40 h-40" rgb={accent} opacity={0.16} blur={10} />
      <div className="relative flex items-center gap-2 mb-4">
        {icon}
        <h3 className="text-[13px] font-[600] tracking-[-0.01em] text-ink/90">{title}</h3>
      </div>
      <div className="relative space-y-0.5">
        {skills.map((skill, index) => (
          <RankedRow key={skill.id} item={skill} rank={ranked ? index + 1 : undefined} />
        ))}
      </div>
    </div>
  );
}
