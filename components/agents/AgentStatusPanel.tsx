"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Types matching /api/agents/state response ──────────────────────

interface ManualQueueState {
  openCount: number;
  executionReadyCount: number;
  inProgressCount: number;
  blockedCount: number;
  selectedCount: number;
  activeManualTask: {
    id: string;
    title: string;
    status: string;
    priority: string;
    taskType: string;
    startedAt?: string | null;
    selectedAt?: string | null;
  } | null;
  nextTitles: string[];
  latestManualExecution: {
    id: string;
    title: string;
    status: string;
    latestExecutionResult: {
      ok: boolean;
      summary?: string;
      commitSha?: string | null;
      error?: string | null;
      finishedAt?: string;
    } | null;
  } | null;
}

interface LatestExecutionResult {
  executionStatus: string | null;
  selectedSource: string | null;
  selectedTaskId: string | null;
  selectedTaskTitle: string | null;
  patchApplied: boolean;
  commitSha: string | null;
  manualTaskStatus: string | null;
}

interface AgentDerivedState {
  posture?: string;
  eventRisk?: string;
  activeIncidentCount?: number;
  openEngineeringTaskCount?: number;
  openExecutionReadyCount?: number;
  blockedTaskCount?: number;
  latestExecutionTaskTitle?: string | null;
  latestExecutionStatus?: string | null;
  latestCommitSha?: string | null;
  latestFailureReason?: string | null;
  latestExecutionResult?: LatestExecutionResult | null;
  githubWriteEnabled?: boolean;
  openIncidentCategories?: string[];
  activeRestrictions?: string[];
}

interface StateApiResponse {
  ok: boolean;
  state?: AgentDerivedState;
  manualQueue?: ManualQueueState;
}

// ─── Component ──────────────────────────────────────────────────────

export function AgentStatusPanel({ refreshSignal }: { refreshSignal?: number }) {
  const [data, setData] = useState<StateApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const fetchingRef = useRef(false);

  const load = useCallback(async () => {
    if (fetchingRef.current) return; // debounce
    fetchingRef.current = true;
    try {
      const res = await fetch("/api/agents/state", { cache: "no-store" });
      if (!res.ok) {
        setErr(`HTTP ${res.status}`);
        return;
      }
      const json: StateApiResponse = await res.json();
      setData(json);
      setErr(null);
    } catch {
      setErr("Network error");
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  // Auto-refresh every 12s
  useEffect(() => {
    load();
    const iv = setInterval(load, 12_000);
    return () => clearInterval(iv);
  }, [load]);

  // External refresh trigger (e.g. after task creation)
  useEffect(() => {
    if (refreshSignal) load();
  }, [refreshSignal, load]);

  const s = data?.state;
  const mq = data?.manualQueue;
  const active = mq?.activeManualTask;
  const latestManual = mq?.latestManualExecution;
  const latestExec = s?.latestExecutionResult;

  return (
    <div className="space-y-4">
      {loading && !data && (
        <div className="text-xs text-[var(--ci-text-muted)] animate-pulse">Loading…</div>
      )}
      {err && <Banner color="red">{err}</Banner>}

      {/* ── Critical blockers ─────────────────────────────────── */}
      {(s?.activeIncidentCount ?? 0) > 0 && (
        <Banner color="red">
          <span className="font-semibold">
            {s!.activeIncidentCount} active incident{s!.activeIncidentCount! > 1 ? "s" : ""}
          </span>
          {s!.openIncidentCategories?.length ? (
            <span className="ml-1">
              ({s!.openIncidentCategories.join(", ")})
            </span>
          ) : null}
          <div className="text-[10px] mt-0.5 opacity-70">
            Execution may be paused. Check incidents for details.
          </div>
        </Banner>
      )}

      {/* ── Posture / risk pills ──────────────────────────────── */}
      {s && (
        <div className="flex flex-wrap items-center gap-2">
          <Pill color={s.posture === "DEFENSIVE" ? "red" : s.posture === "AGGRESSIVE" ? "yellow" : "green"}>
            {s.posture ?? "NORMAL"}
          </Pill>
          <Pill color={s.eventRisk === "HIGH" ? "red" : "neutral"}>
            Risk: {s.eventRisk ?? "LOW"}
          </Pill>
          <Pill color={s.githubWriteEnabled ? "green" : "yellow"}>
            {s.githubWriteEnabled ? "GH write ON" : "GH write OFF"}
          </Pill>
        </div>
      )}

      {/* ── Queue counts ──────────────────────────────────────── */}
      {mq && (
        <Card title="Manual queue">
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            <Stat label="Open" value={mq.openCount} />
            <Stat label="Ready" value={mq.executionReadyCount} />
            <Stat label="Selected" value={mq.selectedCount} />
            <Stat label="Running" value={mq.inProgressCount} />
            <Stat label="Blocked" value={mq.blockedCount} />
          </div>
        </Card>
      )}

      {/* ── Active manual task ────────────────────────────────── */}
      {active ? (
        <Card title="Active task" borderColor="border-blue-700/30">
          <div className="text-sm text-neutral-100 font-medium">{active.title}</div>
          <div className="flex flex-wrap gap-1.5 mt-1">
            <Pill color="blue">{active.status}</Pill>
            <Pill color="neutral">{active.priority}</Pill>
            <Pill color="neutral">{active.taskType}</Pill>
          </div>
          {active.startedAt && (
            <div className="text-[10px] text-[var(--ci-text-muted)] mt-1">
              Started: {new Date(active.startedAt).toLocaleTimeString()}
            </div>
          )}
        </Card>
      ) : (
        <Card title="Active task">
          <div className="text-xs text-neutral-500">No active agent task</div>
        </Card>
      )}

      {/* ── Latest manual execution ───────────────────────────── */}
      {latestManual && (
        <Card title="Latest manual execution">
          <div className="text-xs text-neutral-200">{latestManual.title}</div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            <Pill color={latestManual.status === "DONE" ? "green" : latestManual.status === "FAILED" ? "red" : "yellow"}>
              {latestManual.status}
            </Pill>
            {latestManual.latestExecutionResult?.commitSha && (
              <span className="font-mono text-[10px] text-neutral-500">
                {latestManual.latestExecutionResult.commitSha.slice(0, 7)}
              </span>
            )}
          </div>
          {latestManual.latestExecutionResult?.ok === false && latestManual.latestExecutionResult.error && (
            <div className="text-xs text-red-300 mt-1">
              Failure: {latestManual.latestExecutionResult.error}
            </div>
          )}
          {latestManual.latestExecutionResult?.summary && (
            <div className="text-[11px] text-neutral-400 mt-1 line-clamp-3">
              {latestManual.latestExecutionResult.summary}
            </div>
          )}
        </Card>
      )}

      {/* ── Latest execution result (engineering) ─────────────── */}
      {latestExec?.selectedTaskTitle && (
        <Card title="Latest execution result">
          <div className="text-xs text-neutral-200">{latestExec.selectedTaskTitle}</div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            <Pill color={
              latestExec.executionStatus === "DONE" || latestExec.patchApplied ? "green"
              : latestExec.executionStatus === "FAILED" ? "red"
              : "neutral"
            }>
              {latestExec.executionStatus ?? "—"}
            </Pill>
            <Pill color="neutral">{latestExec.selectedSource ?? "—"}</Pill>
            {latestExec.commitSha && (
              <span className="font-mono text-[10px] text-neutral-500">
                {latestExec.commitSha.slice(0, 7)}
              </span>
            )}
          </div>
          {s?.latestFailureReason && (
            <div className="text-xs text-red-300 mt-1">
              Failure: {s.latestFailureReason}
            </div>
          )}
        </Card>
      )}

      {/* ── Upcoming tasks ────────────────────────────────────── */}
      {mq?.nextTitles && mq.nextTitles.length > 0 && (
        <Card title="Queue preview">
          {mq.nextTitles.map((title, i) => (
            <div key={i} className="text-xs text-neutral-300 py-0.5">
              <span className="text-neutral-600 mr-1">{i + 1}.</span>
              {title}
            </div>
          ))}
        </Card>
      )}

      {/* ── Engineering summary ────────────────────────────────── */}
      {s && (
        <Card title="Engineering tasks">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Open" value={s.openEngineeringTaskCount ?? 0} />
            <Stat label="Ready" value={s.openExecutionReadyCount ?? 0} />
            <Stat label="Blocked" value={s.blockedTaskCount ?? 0} />
          </div>
        </Card>
      )}

      {/* ── Active restrictions ────────────────────────────────── */}
      {s?.activeRestrictions && s.activeRestrictions.length > 0 && (
        <Card title="Active restrictions">
          <div className="text-xs text-yellow-300">
            {s.activeRestrictions.join("; ")}
          </div>
        </Card>
      )}

      {/* ── Refresh button ────────────────────────────────────── */}
      <button
        type="button"
        onClick={load}
        className="w-full rounded-lg border border-[var(--ci-border)] bg-black/30 px-3 py-2 text-xs text-neutral-400 hover:bg-white/5 active:bg-white/10 transition-colors"
      >
        Refresh
      </button>
    </div>
  );
}

// ─── Shared UI pieces ───────────────────────────────────────────────

function Card({
  title,
  borderColor,
  children,
}: {
  title: string;
  borderColor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border ${borderColor ?? "border-[var(--ci-border)]"} bg-black/20 px-4 py-3 space-y-1`}>
      <div className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
        {title}
      </div>
      {children}
    </div>
  );
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  const cls: Record<string, string> = {
    red: "bg-red-900/30 text-red-300 border-red-700/40",
    yellow: "bg-yellow-900/30 text-yellow-300 border-yellow-700/40",
    green: "bg-emerald-900/30 text-emerald-300 border-emerald-700/40",
    blue: "bg-blue-900/30 text-blue-300 border-blue-700/40",
    neutral: "bg-neutral-800/50 text-neutral-300 border-neutral-700/40",
  };
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${cls[color] || cls.neutral}`}>
      {children}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-base font-semibold text-neutral-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">{label}</div>
    </div>
  );
}

function Banner({ color, children }: { color: "red" | "green" | "yellow"; children: React.ReactNode }) {
  const cls: Record<string, string> = {
    red: "border-red-700/40 bg-red-900/20 text-red-300",
    green: "border-emerald-700/40 bg-emerald-900/20 text-emerald-300",
    yellow: "border-yellow-700/40 bg-yellow-900/20 text-yellow-300",
  };
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${cls[color]}`}>
      {children}
    </div>
  );
}
