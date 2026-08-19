"use client";

import { useEffect, useState } from "react";
import { SectionHeader } from "graft-glass-ui/src/components";
import { panelApi } from "../../../lib/api.mjs";

type SkillNode = {
  name: string;
  kind?: string;
  path?: string;
  hasSkillMd?: boolean;
};

export function SkillsView({
  resident,
  adopted,
  inbox,
  selectedPath,
  onSelect,
}: {
  resident: SkillNode[];
  adopted: SkillNode[];
  inbox: SkillNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedPath) {
      setContent("");
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    panelApi
      .getSkill(selectedPath)
      .then((data) => {
        if (cancelled) return;
        setContent(data && data.content ? String(data.content) : "");
      })
      .catch((err) => {
        if (cancelled) return;
        setContent("");
        setError(String(err.message || err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4">
      <div className="space-y-4">
        <SkillGroup title="常驻" items={resident} selectedPath={selectedPath} onSelect={onSelect} />
        <SkillGroup title="已采用" items={adopted} selectedPath={selectedPath} onSelect={onSelect} />
        <SkillGroup title="inbox" items={inbox} selectedPath={selectedPath} onSelect={onSelect} />
      </div>
      <section className="glass p-5 md:p-6 rounded-[22px] min-h-[360px]">
        <SectionHeader title={selectedPath || "技能详情"} description="GET /api/skill?path=" />
        {!selectedPath ? <p className="text-[13.5px] text-ink/45">从左侧选择一条技能。</p> : null}
        {loading ? <p className="text-[13.5px] text-ink/45">读取中…</p> : null}
        {error ? <p className="text-[13.5px] text-orange-600">{error}</p> : null}
        {content ? (
          <pre className="text-[12.5px] leading-6 whitespace-pre-wrap break-all text-ink/80 font-mono">
            {content}
          </pre>
        ) : null}
      </section>
    </div>
  );
}

function SkillGroup({
  title,
  items,
  selectedPath,
  onSelect,
}: {
  title: string;
  items: SkillNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  return (
    <section className="glass p-4 rounded-[22px]">
      <SectionHeader title={`${title} (${items.length})`} />
      <div className="space-y-1">
        {items.length === 0 ? <p className="text-[12.5px] text-ink/40 px-2">没有条目</p> : null}
        {items.map((item) => {
          const path = item.path || "";
          const active = path && path === selectedPath;
          return (
            <button
              key={path || item.name}
              type="button"
              onClick={() => path && onSelect(path)}
              className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors ${
                active ? "bg-ink/[0.06]" : "hover:bg-ink/[0.04]"
              }`}
            >
              <div className="text-[13.5px] font-[550] text-ink truncate">{item.name}</div>
              <div className="text-[11px] text-ink/40 truncate">{path}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
