"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, SectionHeader, StatusPill } from "graft-glass-ui/src/components";
import { createPanelRequestId, panelApi } from "../../../lib/api.mjs";
import { createMutationRetryRegistry } from "../../../lib/mutation-retry.mjs";

type Remote<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; message: string; code?: string };

type JsonRecord = Record<string, unknown>;

type Snapshot = {
  snapshotId: string;
  createdAt?: string;
  files?: unknown[];
  source?: JsonRecord;
};

type Pin = {
  requestedSnapshot?: string | null;
  materializedSnapshot?: string | null;
  selectedSkills?: string[];
  claimState?: string;
};

type PinResult = {
  worktree?: string;
  pathKey?: string;
  worktreeId?: string;
  pin?: Pin | null;
  changed?: boolean;
  action?: string;
};

type Conflict = {
  kind?: string;
  changedFiles?: number;
  addedFiles?: number;
  removedFiles?: number;
};

type Operation = {
  artifactId?: string;
  targetRelativePath?: string;
  action?: string;
  conflict?: Conflict;
};

type Plan = {
  planHash?: string;
  migrationId?: string;
  executable?: boolean;
  summary?: JsonRecord;
  operations?: Operation[];
  git?: {
    configuration?: {
      action?: string;
      conflictKind?: string | null;
      effects?: string[];
    };
  };
};

type PlanResult = {
  action?: string;
  mode?: string;
  status?: string;
  plan?: Plan | null;
  migration?: { migrationId?: string } | null;
  pin?: Pin | null;
  [key: string]: unknown;
};

type HistoryRecord = {
  id?: string;
  type?: string;
  at?: string;
  requestId?: string;
  summary?: string;
  metadata?: JsonRecord;
};

const idle = <T,>(): Remote<T> => ({ state: "idle" });
const loading = <T,>(): Remote<T> => ({ state: "loading" });
const ready = <T,>(value: T): Remote<T> => ({ state: "ready", value });

function failed<T>(error: unknown): Remote<T> {
  const value = error as { message?: string; code?: string };
  return {
    state: "error",
    message: String(value?.message || error),
    ...(value?.code ? { code: value.code } : {}),
  };
}

function ErrorLine({ remote }: { remote: Remote<unknown> }) {
  if (remote.state !== "error") return null;
  return (
    <p className="mt-2 text-[12.5px] text-red-600 break-all">
      {remote.code ? `${remote.code}: ` : ""}
      {remote.message}
    </p>
  );
}

function JsonDetails({ value, label = "完整 Application 结果" }: { value: unknown; label?: string }) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-[12px] text-ink/45">{label}</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-ink/[0.03] p-3 text-[11px] leading-5 text-ink/70">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function PlanResultView({ remote, title }: { remote: Remote<PlanResult>; title: string }) {
  if (remote.state === "idle") {
    return <p className="text-[12.5px] text-ink/40">{title}尚未请求。</p>;
  }
  if (remote.state === "loading") {
    return <p className="text-[12.5px] text-ink/45">{title}请求中…</p>;
  }
  if (remote.state === "error") {
    return <ErrorLine remote={remote} />;
  }

  const result = remote.value;
  const plan = result.plan;
  const conflicts = (plan?.operations || []).filter((operation) => operation.conflict);
  const status = String(result.status || result.mode || "ready");
  const statusTone = status === "conflict" ? "off" : status === "planned" ? "warn" : "ok";
  return (
    <div className="rounded-2xl border border-ink/[0.06] bg-ink/[0.02] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-[600] text-ink">{title}</span>
        <StatusPill status={statusTone} label={status} />
        {plan ? (
          <StatusPill
            status={plan.executable ? "ok" : "off"}
            label={plan.executable ? "executable" : "blocked"}
          />
        ) : null}
      </div>
      {plan?.planHash ? (
        <p className="mt-2 break-all font-mono text-[11px] text-ink/55">planHash={plan.planHash}</p>
      ) : null}
      {plan?.migrationId ? (
        <p className="mt-1 break-all font-mono text-[11px] text-ink/55">migrationId={plan.migrationId}</p>
      ) : null}
      {plan?.summary ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {Object.entries(plan.summary).map(([key, value]) => (
            <span key={key} className="rounded-full bg-ink/[0.05] px-2 py-1 text-[11px] text-ink/60">
              {key}={String(value)}
            </span>
          ))}
        </div>
      ) : null}
      {plan?.git?.configuration ? (
        <p className="mt-2 text-[12px] text-ink/55">
          git.configuration={plan.git.configuration.action || "—"}
          {plan.git.configuration.conflictKind
            ? ` · conflictKind=${plan.git.configuration.conflictKind}`
            : ""}
        </p>
      ) : null}
      {conflicts.length > 0 ? (
        <div className="mt-3 space-y-2">
          {conflicts.map((operation, index) => (
            <div key={`${operation.artifactId || index}`} className="rounded-xl bg-red-500/[0.06] p-2 text-[11.5px]">
              <p className="font-[600] text-red-700">
                {operation.artifactId || operation.targetRelativePath || `conflict-${index + 1}`}
              </p>
              <p className="text-red-700/80">
                kind={operation.conflict?.kind || "unknown"} · changed=
                {operation.conflict?.changedFiles ?? 0} · added={operation.conflict?.addedFiles ?? 0} · removed=
                {operation.conflict?.removedFiles ?? 0}
              </p>
            </div>
          ))}
        </div>
      ) : null}
      {(plan?.operations || []).length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[12px] text-ink/45">
            operations ({plan?.operations?.length || 0})
          </summary>
          <div className="mt-2 space-y-1">
            {(plan?.operations || []).map((operation, index) => (
              <div key={`${operation.artifactId || index}`} className="flex gap-2 text-[11.5px] text-ink/60">
                <span className="min-w-20 font-mono">{operation.action || "—"}</span>
                <span className="break-all">{operation.targetRelativePath || operation.artifactId || "—"}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <JsonDetails value={result} />
    </div>
  );
}

export function WorkspaceOperations({ worktree }: { worktree: string }) {
  const [snapshots, setSnapshots] = useState<Remote<{ snapshots?: Snapshot[] }>>(idle);
  const [pin, setPin] = useState<Remote<PinResult>>(idle);
  const [history, setHistory] = useState<Remote<{ records?: HistoryRecord[] }>>(idle);
  const [pinWrite, setPinWrite] = useState<Remote<PinResult>>(idle);
  const [syncPlan, setSyncPlan] = useState<Remote<PlanResult>>(idle);
  const [syncResult, setSyncResult] = useState<Remote<JsonRecord>>(idle);
  const [migrationPlan, setMigrationPlan] = useState<Remote<PlanResult>>(idle);
  const [migrationResult, setMigrationResult] = useState<Remote<PlanResult>>(idle);
  const [rollbackPlan, setRollbackPlan] = useState<Remote<PlanResult>>(idle);
  const [rollbackResult, setRollbackResult] = useState<Remote<PlanResult>>(idle);
  const [snapshotId, setSnapshotId] = useState("");
  const [selectedSkills, setSelectedSkills] = useState("");
  const [migrationId, setMigrationId] = useState("");
  const retryIds = useRef(createMutationRetryRegistry({ createRequestId: createPanelRequestId })).current;

  const load = useCallback(async () => {
    if (!worktree) return;
    setSnapshots(loading());
    setPin(loading());
    setHistory(loading());
    const [snapshotResult, pinResult, historyResult] = await Promise.allSettled([
      panelApi.getSnapshots(),
      panelApi.getPin(worktree),
      panelApi.getHistory({ limit: 50 }),
    ]);
    setSnapshots(
      snapshotResult.status === "fulfilled"
        ? ready(snapshotResult.value)
        : failed(snapshotResult.reason),
    );
    setPin(
      pinResult.status === "fulfilled"
        ? ready(pinResult.value)
        : failed(pinResult.reason),
    );
    setHistory(
      historyResult.status === "fulfilled"
        ? ready(historyResult.value)
        : failed(historyResult.reason),
    );
  }, [worktree]);

  useEffect(() => {
    setPinWrite(idle());
    setSyncPlan(idle());
    setSyncResult(idle());
    setMigrationPlan(idle());
    setMigrationResult(idle());
    setRollbackPlan(idle());
    setRollbackResult(idle());
    setMigrationId("");
    retryIds.clearAll();
    void load();
  }, [load, retryIds]);

  useEffect(() => {
    if (pin.state !== "ready") return;
    const current = pin.value.pin;
    if (current?.requestedSnapshot) setSnapshotId(current.requestedSnapshot);
    setSelectedSkills((current?.selectedSkills || []).join(", "));
  }, [pin]);

  useEffect(() => {
    if (snapshotId || snapshots.state !== "ready") return;
    const first = snapshots.value.snapshots?.[0];
    if (first?.snapshotId) setSnapshotId(first.snapshotId);
  }, [snapshotId, snapshots]);

  const skills = useMemo(
    () => selectedSkills.split(",").map((value) => value.trim()).filter(Boolean),
    [selectedSkills],
  );
  const pinFingerprint = useMemo(
    () => JSON.stringify([worktree, snapshotId, skills]),
    [worktree, snapshotId, skills],
  );

  useEffect(() => {
    retryIds.clear("setPin");
    setPinWrite(idle());
  }, [pinFingerprint, retryIds]);

  const runSetPin = async () => {
    const requestId = retryIds.requestId("setPin", pinFingerprint, "setPin");
    setPinWrite(loading());
    try {
      const value = await panelApi.setPin(worktree, snapshotId, skills, { requestId });
      setPinWrite(ready(value));
      retryIds.clear("setPin", pinFingerprint);
      setSyncPlan(idle());
      setSyncResult(idle());
      setMigrationPlan(idle());
      setMigrationResult(idle());
      setRollbackPlan(idle());
      setRollbackResult(idle());
      retryIds.clear("sync");
      retryIds.clear("migrateCommit");
      retryIds.clear("rollbackCommit");
      await load();
    } catch (error) {
      setPinWrite(failed(error));
    }
  };

  const runPlanSync = async () => {
    retryIds.clear("sync");
    setSyncPlan(loading());
    setSyncResult(idle());
    try {
      setSyncPlan(ready(await panelApi.planSync(worktree)));
    } catch (error) {
      setSyncPlan(failed(error));
    }
  };

  const runSync = async () => {
    if (syncPlan.state !== "ready" || !syncPlan.value.plan?.planHash) return;
    const plannedHash = syncPlan.value.plan.planHash;
    const fingerprint = JSON.stringify([worktree, plannedHash]);
    const requestId = retryIds.requestId("sync", fingerprint, "sync");
    setSyncResult(loading());
    try {
      setSyncResult(ready(await panelApi.sync(worktree, plannedHash, undefined, { requestId })));
      retryIds.clear("sync", fingerprint);
      await load();
    } catch (error) {
      setSyncResult(failed(error));
    }
  };

  const runMigrationDryRun = async () => {
    retryIds.clear("migrateCommit");
    setMigrationPlan(loading());
    setMigrationResult(idle());
    try {
      const value = await panelApi.migrateLegacy(worktree, "dryRun");
      setMigrationPlan(ready(value));
      if (value.plan?.migrationId) setMigrationId(value.plan.migrationId);
    } catch (error) {
      setMigrationPlan(failed(error));
    }
  };

  const runMigrationCommit = async () => {
    if (migrationPlan.state !== "ready" || !migrationPlan.value.plan?.planHash) return;
    const planHash = migrationPlan.value.plan.planHash;
    const fingerprint = JSON.stringify([worktree, planHash]);
    const requestId = retryIds.requestId("migrateCommit", fingerprint, "migrateLegacy");
    setMigrationResult(loading());
    try {
      const value = await panelApi.migrateLegacy(
        worktree,
        "commit",
        planHash,
        { requestId },
      );
      setMigrationResult(ready(value));
      retryIds.clear("migrateCommit", fingerprint);
      const committedId = value.migration?.migrationId || value.plan?.migrationId;
      if (committedId) setMigrationId(committedId);
      setSyncPlan(idle());
      setSyncResult(idle());
      await load();
    } catch (error) {
      setMigrationResult(failed(error));
    }
  };

  const runRollbackDryRun = async () => {
    if (!migrationId.trim()) return;
    retryIds.clear("rollbackCommit");
    setRollbackPlan(loading());
    setRollbackResult(idle());
    try {
      setRollbackPlan(ready(await panelApi.rollbackLegacy(
        worktree,
        migrationId.trim(),
        "dryRun",
      )));
    } catch (error) {
      setRollbackPlan(failed(error));
    }
  };

  const runRollbackCommit = async () => {
    if (rollbackPlan.state !== "ready" || !rollbackPlan.value.plan?.planHash || !migrationId.trim()) return;
    const planHash = rollbackPlan.value.plan.planHash;
    const fingerprint = JSON.stringify([worktree, migrationId.trim(), planHash]);
    const requestId = retryIds.requestId("rollbackCommit", fingerprint, "rollbackLegacyMigration");
    setRollbackResult(loading());
    try {
      setRollbackResult(ready(await panelApi.rollbackLegacy(
        worktree,
        migrationId.trim(),
        "commit",
        planHash,
        { requestId },
      )));
      retryIds.clear("rollbackCommit", fingerprint);
      setSyncPlan(idle());
      setSyncResult(idle());
      await load();
    } catch (error) {
      setRollbackResult(failed(error));
    }
  };

  const currentPin = pin.state === "ready" ? pin.value.pin : null;
  const canSync =
    syncPlan.state === "ready"
    && syncPlan.value.status === "planned"
    && syncPlan.value.plan?.executable === true
    && Boolean(syncPlan.value.plan.planHash)
    && syncResult.state !== "ready";
  const canMigrate =
    migrationPlan.state === "ready"
    && migrationPlan.value.mode === "dryRun"
    && migrationPlan.value.status === "planned"
    && migrationPlan.value.plan?.executable === true
    && Boolean(migrationPlan.value.plan.planHash)
    && migrationResult.state !== "ready";
  const canRollback =
    rollbackPlan.state === "ready"
    && rollbackPlan.value.mode === "dryRun"
    && rollbackPlan.value.status === "planned"
    && rollbackPlan.value.plan?.executable === true
    && Boolean(rollbackPlan.value.plan.planHash)
    && rollbackResult.state !== "ready";

  return (
    <div className="mt-4 space-y-4">
      <section className="glass rounded-[22px] p-5 md:p-6">
        <SectionHeader
          title="Pin"
          description="getPin / listSnapshots / setPin；提交 pin 不会自动执行 sync。"
        />
        <p className="mb-3 break-all font-mono text-[11.5px] text-ink/45">{worktree}</p>
        {pin.state === "loading" ? <p className="text-[12.5px] text-ink/45">读取 pin…</p> : null}
        <ErrorLine remote={pin} />
        {currentPin ? (
          <div className="mb-3 rounded-xl bg-ink/[0.03] p-3 text-[12px] text-ink/60">
            <p>claimState={currentPin.claimState || "—"}</p>
            <p className="break-all">requested={currentPin.requestedSnapshot || "—"}</p>
            <p className="break-all">materialized={currentPin.materializedSnapshot || "—"}</p>
          </div>
        ) : pin.state === "ready" ? (
          <p className="mb-3 text-[12.5px] text-ink/40">当前工作树没有 pin。</p>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-2">
          <label className="text-[12px] text-ink/50">
            snapshot
            <select
              value={snapshotId}
              onChange={(event) => setSnapshotId(event.target.value)}
              className="mt-1 w-full rounded-xl border border-ink/[0.07] bg-white/40 px-3 py-2 text-[12px] text-ink"
            >
              <option value="">选择 snapshot</option>
              {(snapshots.state === "ready" ? snapshots.value.snapshots || [] : []).map((snapshot) => (
                <option key={snapshot.snapshotId} value={snapshot.snapshotId}>
                  {snapshot.snapshotId} {snapshot.createdAt ? `· ${snapshot.createdAt}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px] text-ink/50">
            selectedSkills（逗号分隔）
            <input
              value={selectedSkills}
              onChange={(event) => setSelectedSkills(event.target.value)}
              className="mt-1 w-full rounded-xl border border-ink/[0.07] bg-white/40 px-3 py-2 text-[12px] text-ink"
              placeholder="ozdqp-development, ozdqp-ui-development"
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="accent"
            loading={pinWrite.state === "loading"}
            disabled={!snapshotId || pinWrite.state === "ready"}
            onClick={() => void runSetPin()}
          >
            保存 pin
          </Button>
          <Button size="sm" variant="glass" onClick={() => void load()}>
            刷新
          </Button>
        </div>
        <ErrorLine remote={snapshots} />
        <ErrorLine remote={pinWrite} />
        {pinWrite.state === "ready" ? <JsonDetails value={pinWrite.value} label="setPin 结果" /> : null}
      </section>

      <section className="glass rounded-[22px] p-5 md:p-6">
        <SectionHeader
          title="同步计划"
          description="planSync 仅预览；sync 只提交当前 Application 返回的 planHash。"
        />
        <div className="mb-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="glass"
            loading={syncPlan.state === "loading"}
            disabled={syncResult.state === "loading"}
            onClick={() => void runPlanSync()}
          >
            预览计划
          </Button>
          <Button
            size="sm"
            variant="accent"
            loading={syncResult.state === "loading"}
            disabled={!canSync}
            onClick={() => void runSync()}
          >
            执行 sync
          </Button>
        </div>
        <PlanResultView remote={syncPlan} title="planSync" />
        <ErrorLine remote={syncResult} />
        {syncResult.state === "ready" ? <JsonDetails value={syncResult.value} label="sync 结果" /> : null}
      </section>

      <section className="glass rounded-[22px] p-5 md:p-6">
        <SectionHeader
          title="Legacy migration"
          description="dryRun 与 commit 分离；commit 复用 dryRun 返回的精确 planHash。"
        />
        <div className="mb-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="glass"
            loading={migrationPlan.state === "loading"}
            disabled={migrationResult.state === "loading"}
            onClick={() => void runMigrationDryRun()}
          >
            migration dry-run
          </Button>
          <Button
            size="sm"
            variant="accent"
            loading={migrationResult.state === "loading"}
            disabled={!canMigrate}
            onClick={() => void runMigrationCommit()}
          >
            commit migration
          </Button>
        </div>
        <PlanResultView remote={migrationPlan} title="migrateLegacy dryRun" />
        <ErrorLine remote={migrationResult} />
        {migrationResult.state === "ready" ? (
          <JsonDetails value={migrationResult.value} label="migrateLegacy commit 结果" />
        ) : null}

        <div className="mt-4 border-t border-ink/[0.06] pt-4">
          <label className="block text-[12px] text-ink/50">
            migrationId
            <input
              value={migrationId}
              onChange={(event) => {
                setMigrationId(event.target.value);
                setRollbackPlan(idle());
                setRollbackResult(idle());
                retryIds.clear("rollbackCommit");
              }}
              className="mt-1 w-full rounded-xl border border-ink/[0.07] bg-white/40 px-3 py-2 font-mono text-[11.5px] text-ink"
              placeholder="sha256:…"
            />
          </label>
          <div className="my-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="glass"
              loading={rollbackPlan.state === "loading"}
              disabled={!migrationId.trim() || rollbackResult.state === "loading"}
              onClick={() => void runRollbackDryRun()}
            >
              rollback dry-run
            </Button>
            <Button
              size="sm"
              variant="accent"
              loading={rollbackResult.state === "loading"}
              disabled={!canRollback}
              onClick={() => void runRollbackCommit()}
            >
              commit rollback
            </Button>
          </div>
          <PlanResultView remote={rollbackPlan} title="rollbackLegacyMigration dryRun" />
          <ErrorLine remote={rollbackResult} />
          {rollbackResult.state === "ready" ? (
            <JsonDetails value={rollbackResult.value} label="rollbackLegacyMigration commit 结果" />
          ) : null}
        </div>
      </section>

      <section className="glass rounded-[22px] p-5 md:p-6">
        <SectionHeader title="历史" description="listHistory 的 Application 结果，只读渲染。" />
        {history.state === "loading" ? <p className="text-[12.5px] text-ink/45">读取历史…</p> : null}
        <ErrorLine remote={history} />
        {history.state === "ready" ? (
          <div className="space-y-2">
            {(history.value.records || []).length === 0 ? (
              <p className="text-[12.5px] text-ink/40">没有历史记录。</p>
            ) : null}
            {(history.value.records || []).map((record, index) => (
              <div key={record.id || `${record.type || "record"}-${index}`} className="rounded-xl bg-ink/[0.03] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12.5px] font-[600] text-ink">{record.type || "record"}</span>
                  <span className="text-[11px] text-ink/40">{record.at || "—"}</span>
                </div>
                <p className="mt-1 break-all font-mono text-[10.5px] text-ink/40">
                  {record.id || "—"} {record.requestId ? `· ${record.requestId}` : ""}
                </p>
                {record.summary ? <p className="mt-1 text-[12px] text-ink/60">{record.summary}</p> : null}
                {record.metadata ? <JsonDetails value={record.metadata} label="metadata" /> : null}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
