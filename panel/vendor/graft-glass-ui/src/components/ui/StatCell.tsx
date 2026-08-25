import type { ReactNode } from "react";

export type StatItem = {
  title: string;
  desc: string;
  icon: ReactNode;
};

export function StatCell({ title, desc, icon }: StatItem) {
  return (
    <div className="flex items-start gap-3 p-5">
      <div className="w-9 h-9 rounded-[11px] border border-ink/10 bg-ink/[0.03] flex items-center justify-center text-ink/55 shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[13.5px] font-[500] text-ink/85 mb-0.5">{title}</div>
        <div className="text-[12px] font-[400] text-ink/40 leading-[1.45]">{desc}</div>
      </div>
    </div>
  );
}

export function FeatureStrip({ items }: { items: StatItem[] }) {
  return (
    <div className="mt-6 mb-2 rounded-2xl border border-ink/[0.06] bg-ink/[0.015] grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-ink/[0.05]">
      {items.map((item) => (
        <StatCell key={item.title} {...item} />
      ))}
    </div>
  );
}
