"use client";

import type { ReactNode } from "react";
import { IconChevron } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { IconTile } from "@/components/ui/IconTile";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { TagChip, VersionChip } from "@/components/hub/VersionChip";

export type AttentionKind = "update" | "repair";

export type AttentionItem = {
  id: string;
  kind: AttentionKind;
  title: string;
  description: string;
  fromVersion?: string;
  toVersion?: string;
  versionPrefix?: string;
  timeLabel?: string;
  people?: string[];
  extraPeople?: number;
  icon?: ReactNode;
  rgb?: string;
};

type AttentionListProps = {
  items: AttentionItem[];
  onPrimary?: (item: AttentionItem) => void;
  onSecondary?: (item: AttentionItem) => void;
  onSeeAll?: () => void;
};

export function AttentionList({ items, onPrimary, onSecondary, onSeeAll }: AttentionListProps) {
  if (!items.length) return null;
  return (
    <section className="glass p-5 md:p-6 rounded-[22px]">
      <SectionHeader
        title={`需要你处理 (${items.length})`}
        actionLabel="查看全部待处理"
        onAction={onSeeAll}
      />
      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="group flex flex-col lg:flex-row lg:items-center gap-3 rounded-2xl px-3 py-3 hover:bg-ink/[0.03] transition-colors"
          >
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <IconTile rgb={item.rgb || (item.kind === "repair" ? "168,85,247" : "99,102,241")} size={40}>
                {item.icon || item.title[0]?.toUpperCase()}
              </IconTile>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[14px] font-[600] text-ink truncate">{item.title}</span>
                  <VersionChip from={item.fromVersion} to={item.toVersion} prefix={item.versionPrefix} />
                  {item.kind === "update" ? <TagChip>官方更新</TagChip> : <TagChip tone="warn">需要修复</TagChip>}
                </div>
                <p className="text-[12.5px] text-ink/45 mt-0.5 line-clamp-1">{item.description}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 lg:pl-3">
              {item.timeLabel ? <span className="text-[12px] text-ink/35 hidden md:block">{item.timeLabel}</span> : null}
              {item.people?.length ? (
                <div className="hidden sm:flex items-center -space-x-2 mr-1">
                  {item.people.slice(0, 3).map((name) => (
                    <Avatar key={name} name={name} size={22} className="ring-2 ring-page" />
                  ))}
                  {item.extraPeople ? (
                    <span className="text-[11px] text-ink/40 pl-3">+{item.extraPeople}</span>
                  ) : null}
                </div>
              ) : null}
              {item.kind === "update" ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => onSecondary?.(item)}>
                    查看变化
                  </Button>
                  <Button size="sm" variant="accent" onClick={() => onPrimary?.(item)}>
                    处理更新 <IconChevron size={12} />
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="glass" onClick={() => onPrimary?.(item)}>
                  修复工作区
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
