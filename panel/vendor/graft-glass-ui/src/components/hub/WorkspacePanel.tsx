"use client";

import { StatusPill, type HubStatus } from "@/components/hub/StatusPill";
import { SectionHeader } from "@/components/ui/SectionHeader";

export type WorkspaceRow = {
  id: string;
  name: string;
  status: HubStatus;
  statusLabel: string;
};

export function WorkspacePanel({
  items,
  onSeeAll,
  onSelect,
}: {
  items: WorkspaceRow[];
  onSeeAll?: () => void;
  onSelect?: (item: WorkspaceRow) => void;
}) {
  return (
    <aside className="glass p-5 rounded-[22px] h-full">
      <SectionHeader title="工作区" actionLabel="查看全部" onAction={onSeeAll} />
      <div className="space-y-1">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect?.(item)}
            className="w-full flex items-center justify-between gap-3 px-2 py-2.5 rounded-xl hover:bg-ink/[0.04] transition-colors text-left"
          >
            <span className="text-[13.5px] font-[500] text-ink truncate">{item.name}</span>
            <StatusPill status={item.status} label={item.statusLabel} />
          </button>
        ))}
      </div>
    </aside>
  );
}
