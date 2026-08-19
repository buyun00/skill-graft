"use client";

import { Button, SectionHeader, StatusPill, useTheme } from "graft-glass-ui/src/components";

export function SettingsView({
  hubRoot,
  gameRepo,
  daemon,
}: {
  hubRoot: string;
  gameRepo: string | null;
  daemon: Record<string, unknown> | null;
}) {
  const { mode, toggleMode } = useTheme();
  const daemonOk = Boolean(daemon && daemon.ok);
  return (
    <div className="space-y-4">
      <section className="glass p-5 md:p-6 rounded-[22px]">
        <SectionHeader title="本机路径" description="只读。网页不改仓库识别规则。" />
        <dl className="space-y-3 text-[13.5px]">
          <div>
            <dt className="text-ink/40 text-[12px]">hubRoot</dt>
            <dd className="text-ink font-[500] break-all">{hubRoot || "—"}</dd>
          </div>
          <div>
            <dt className="text-ink/40 text-[12px]">gameRepo</dt>
            <dd className="text-ink font-[500] break-all">{gameRepo || "—"}</dd>
          </div>
        </dl>
      </section>
      <section className="glass p-5 md:p-6 rounded-[22px]">
        <SectionHeader title="守护进程" />
        <div className="flex items-center gap-2 mb-3">
          <StatusPill status={daemonOk ? "ok" : "off"} label={daemonOk ? "正常" : "未就绪"} />
        </div>
        <pre className="text-[12px] leading-6 whitespace-pre-wrap break-all text-ink/70 font-mono">
          {daemon ? JSON.stringify(daemon, null, 2) : "—"}
        </pre>
      </section>
      <section className="glass p-5 md:p-6 rounded-[22px]">
        <SectionHeader title="外观" description="浅色贴稿，深色也可读。" />
        <Button variant="glass" onClick={toggleMode}>
          当前主题：{mode === "dark" ? "深色" : "浅色"}（切换）
        </Button>
      </section>
    </div>
  );
}
