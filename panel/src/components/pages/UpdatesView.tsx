"use client";

import { useState } from "react";
import { Button, SectionHeader, TagChip, VersionChip } from "graft-glass-ui/src/components";
import { versionParts } from "../../../lib/overview-mapping.mjs";

type InboxItem = {
  id: string;
  name?: string;
  status?: string;
  oldCommit?: string;
  newCommit?: string;
  note?: string;
  suggestion?: { action?: string; reason?: string; target?: string };
};

export function UpdatesView({
  items,
  selectedId,
  busy,
  onSelect,
  onAnalyze,
  onDecide,
}: {
  items: InboxItem[];
  selectedId: string;
  busy?: boolean;
  onSelect: (id: string) => void;
  onAnalyze: () => void;
  onDecide: (id: string, action: string, extra?: { note?: string; mergeTarget?: string }) => void;
}) {
  const selected = items.find((item) => item.id === selectedId) || null;
  const [note, setNote] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
      <section className="glass p-5 md:p-6 rounded-[22px]">
        <SectionHeader title="更新中心" description="state.items · POST /api/analyze · POST /api/decide" />
        <div className="mb-4">
          <Button size="sm" variant="accent" loading={busy} onClick={onAnalyze}>
            分析排队更新
          </Button>
        </div>
        <div className="space-y-2">
          {items.length === 0 ? <p className="text-[13.5px] text-ink/45">没有 inbox 条目。</p> : null}
          {items.map((item) => {
            const versions = versionParts(item);
            const active = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                className={`w-full text-left rounded-2xl px-3 py-3 transition-colors ${
                  active ? "bg-ink/[0.06]" : "hover:bg-ink/[0.04]"
                }`}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[14px] font-[600] text-ink">{item.name || item.id}</span>
                  {versions.showVersionChip ? (
                    <VersionChip from={versions.fromVersion} to={versions.toVersion} prefix="" />
                  ) : null}
                  <TagChip>{item.status || "unknown"}</TagChip>
                </div>
                <p className="text-[12.5px] text-ink/45 mt-0.5 line-clamp-2">
                  {(item.suggestion && item.suggestion.reason) || item.id}
                </p>
              </button>
            );
          })}
        </div>
      </section>
      <section className="glass p-5 rounded-[22px]">
        <SectionHeader title={selected ? selected.name || selected.id : "条目详情"} />
        {!selected ? (
          <p className="text-[13.5px] text-ink/45">
            {selectedId ? `未找到 ${selectedId}` : "选择一条更新。"}
          </p>
        ) : (
          <div className="space-y-3 text-[13px]">
            <p className="text-ink/50 break-all">{selected.id}</p>
            <p>{(selected.suggestion && selected.suggestion.reason) || "暂无 suggestion.reason"}</p>
            <label className="block">
              <span className="text-[12px] text-ink/40">备注</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-ink/[0.03] border border-ink/[0.06] text-ink"
              />
            </label>
            <label className="block">
              <span className="text-[12px] text-ink/40">mergeTarget</span>
              <input
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-ink/[0.03] border border-ink/[0.06] text-ink"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="accent" disabled={busy} onClick={() => onDecide(selected.id, "adopt", { note })}>
                adopt
              </Button>
              <Button
                size="sm"
                variant="glass"
                disabled={busy}
                onClick={() => onDecide(selected.id, "merge", { note, mergeTarget })}
              >
                merge
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(selected.id, "reject", { note })}>
                reject
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
