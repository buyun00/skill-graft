"use client";

import { Button, SectionHeader, StatusPill, useTheme } from "graft-glass-ui/src/components";
import { mapDoctorDiagnostics } from "../../../lib/diagnostics-view.mjs";

type Check = {
  ok?: boolean;
  path?: string;
  version?: string;
  detail?: string;
};

type DoctorReport = {
  ok?: boolean;
  hubRoot?: string;
  command?: string;
  node?: Check;
  git?: Check;
  dist?: Check;
  codex?: Check;
  layout?: { ok?: boolean; missing?: string[] };
  shims?: { ok?: boolean; cmd?: string; alias?: string; unix?: string };
  path?: { ok?: boolean; binDir?: string; onUserPath?: boolean; extraShimDir?: string | null };
  daemon?: Record<string, unknown>;
  lifecycle?: {
    manifest?: boolean;
    ownership?: boolean;
    lockHealthy?: boolean;
    dataMarker?: boolean;
    packageVersion?: string;
    installedVersion?: string;
    versionMatch?: boolean;
    corpusEmpty?: boolean;
    lockState?: string;
    walPending?: boolean;
    durablePending?: number;
    reviewLocks?: { active?: number; stale?: number; unverifiable?: number };
  };
  issues?: Array<{ level?: string; message?: string }>;
};

function DiagnosticCheck({ label, check }: { label: string; check?: Check }) {
  const ok = Boolean(check?.ok);
  return (
    <div className="rounded-xl bg-ink/[0.03] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-[600] text-ink">{label}</span>
        <StatusPill status={ok ? "ok" : "off"} label={ok ? "ok" : "issue"} />
      </div>
      <p className="mt-1 break-all font-mono text-[10.5px] text-ink/45">{check?.path || "—"}</p>
      {check?.version ? <p className="mt-1 text-[11.5px] text-ink/55">{check.version}</p> : null}
      {check?.detail ? <p className="mt-1 text-[11.5px] text-ink/55">{check.detail}</p> : null}
    </div>
  );
}

function RawFact({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-xl bg-ink/[0.03] p-3">
      <p className="text-[11px] text-ink/40">{label}</p>
      <p className="mt-1 break-all font-mono text-[12px] text-ink/70">
        {value === undefined || value === null || value === "" ? "—" : String(value)}
      </p>
    </div>
  );
}
export function SettingsView({
  hubRoot,
  gameRepo,
  daemon,
  diagnostics,
}: {
  hubRoot: string;
  gameRepo: string | null;
  daemon: Record<string, unknown> | null;
  diagnostics: Record<string, unknown> | null;
}) {
  const { mode, toggleMode } = useTheme();
  const report = (diagnostics || {}) as DoctorReport;
  const doctorView = mapDoctorDiagnostics(report);
  const daemonOk = Boolean(daemon && daemon.ok);
  return (
    <div className="space-y-4">
      <section className="glass p-5 md:p-6 rounded-[22px]">
        <SectionHeader title="本机路径" description="只读。网页不改仓库识别规则。" />
        <dl className="space-y-3 text-[13.5px]">
          <div>
            <dt className="text-ink/40 text-[12px]">package hubRoot</dt>
            <dd className="text-ink font-[500] break-all">{hubRoot || "—"}</dd>
          </div>
          <div>
            <dt className="text-ink/40 text-[12px]">doctor hubRoot</dt>
            <dd className="text-ink font-[500] break-all">{report.hubRoot || "—"}</dd>
          </div>
          <div>
            <dt className="text-ink/40 text-[12px]">gameRepo</dt>
            <dd className="text-ink font-[500] break-all">{gameRepo || "—"}</dd>
          </div>
        </dl>
      </section>

      <section className="glass p-5 md:p-6 rounded-[22px]">
        <SectionHeader
          title="Host diagnostics"
          description="GET /api/host/diagnostics；纯渲染 doctorHub 的同一宿主上下文结果。"
        />
        <div className="mb-3 flex items-center gap-2">
          <StatusPill status={report.ok ? "ok" : "off"} label={report.ok ? "全部通过" : "存在问题"} />
          {report.command ? <span className="text-[12px] text-ink/45">{report.command}</span> : null}
        </div>
        <div className="mb-3 grid gap-2 md:grid-cols-[160px_1fr]">
          <RawFact label="API port" value={doctorView.apiPort} />
          <RawFact label="API URL" value={doctorView.apiUrl} />
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <DiagnosticCheck label="Node" check={report.node} />
          <DiagnosticCheck label="Git" check={report.git} />
          <DiagnosticCheck label="dist / CLI" check={report.dist} />
          <DiagnosticCheck label="Codex" check={report.codex} />
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <div className="rounded-xl bg-ink/[0.03] p-3">
            <p className="text-[12.5px] font-[600] text-ink">layout</p>
            <StatusPill status={report.layout?.ok ? "ok" : "off"} label={report.layout?.ok ? "ok" : "missing"} />
            {(report.layout?.missing || []).map((item) => (
              <p key={item} className="mt-1 break-all font-mono text-[10.5px] text-ink/45">{item}</p>
            ))}
          </div>
          <div className="rounded-xl bg-ink/[0.03] p-3">
            <p className="text-[12.5px] font-[600] text-ink">shims</p>
            <StatusPill status={report.shims?.ok ? "ok" : "off"} label={report.shims?.ok ? "ok" : "issue"} />
            <pre className="mt-1 whitespace-pre-wrap break-all text-[10.5px] text-ink/45">
              {report.shims ? JSON.stringify(report.shims, null, 2) : "—"}
            </pre>
          </div>
          <div className="rounded-xl bg-ink/[0.03] p-3">
            <p className="text-[12.5px] font-[600] text-ink">PATH</p>
            <StatusPill status={report.path?.ok ? "ok" : "off"} label={report.path?.ok ? "ok" : "issue"} />
            <p className="mt-1 break-all font-mono text-[10.5px] text-ink/45">{report.path?.binDir || "—"}</p>
            <p className="mt-1 text-[10.5px] text-ink/45">
              onUserPath={String(report.path?.onUserPath ?? false)}
            </p>
          </div>
        </div>

        {(report.issues || []).length > 0 ? (
          <div className="mt-3 space-y-1 rounded-xl bg-red-500/[0.06] p-3">
            {(report.issues || []).map((issue, index) => (
              <p key={`${issue.level || "issue"}-${index}`} className="text-[11.5px] text-red-700">
                {issue.level || "issue"}: {issue.message || "unknown"}
              </p>
            ))}
          </div>
        ) : null}

        <div className="mt-4 border-t border-ink/[0.06] pt-4">
          <h3 className="text-[13px] font-[650] text-ink">Lifecycle（doctor.lifecycle）</h3>
          <p className="mt-1 text-[11.5px] text-ink/45">
            以下值逐字段显示服务端事实；面板不重新计算 doctor.ok。
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <RawFact label="manifest" value={doctorView.lifecycle.manifest} />
            <RawFact label="ownership" value={doctorView.lifecycle.ownership} />
            <RawFact label="lockHealthy" value={doctorView.lifecycle.lockHealthy} />
            <RawFact label="dataMarker" value={doctorView.lifecycle.dataMarker} />
            <RawFact label="packageVersion" value={doctorView.lifecycle.packageVersion} />
            <RawFact label="installedVersion" value={doctorView.lifecycle.installedVersion} />
            <RawFact label="versionMatch" value={doctorView.lifecycle.versionMatch} />
            <RawFact label="corpusEmpty" value={doctorView.lifecycle.corpusEmpty} />
            <RawFact label="lockState" value={doctorView.lifecycle.lockState} />
            <RawFact label="walPending" value={doctorView.lifecycle.walPending} />
            <RawFact label="durablePending" value={doctorView.lifecycle.durablePending} />
            <RawFact label="reviewLocks.active" value={doctorView.lifecycle.reviewLocks.active} />
            <RawFact label="reviewLocks.stale" value={doctorView.lifecycle.reviewLocks.stale} />
            <RawFact label="reviewLocks.unverifiable" value={doctorView.lifecycle.reviewLocks.unverifiable} />
          </div>
        </div>
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
