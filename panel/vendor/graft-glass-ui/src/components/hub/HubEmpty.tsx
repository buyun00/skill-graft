"use client";

import { IconCheck, IconSparkle } from "@/components/icons";
import { Button } from "@/components/ui/Button";

export function HubEmpty({
  title = "一切正常",
  description = "没有待处理的更新或问题，所有工作区均已连接。",
  actionLabel = "打开 Codex 助手",
  onAction,
}: {
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section className="glass rounded-[22px] min-h-[280px] flex flex-col items-center justify-center text-center px-6 py-14">
      <div className="relative mb-5">
        <div
          className="absolute inset-[-12px] rounded-full blur-2xl animate-emptyOrb"
          style={{ background: "radial-gradient(circle, rgba(16,185,129,0.28), transparent 70%)" }}
        />
        <div className="relative w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500">
          <IconCheck size={28} />
        </div>
      </div>
      <h2 className="text-[20px] font-[600] tracking-[-0.02em] text-ink mb-2">{title}</h2>
      <p className="text-[14px] text-ink/45 max-w-[380px] mb-6">{description}</p>
      <Button variant="glass" icon={<IconSparkle size={14} />} onClick={onAction}>
        {actionLabel}
      </Button>
    </section>
  );
}
