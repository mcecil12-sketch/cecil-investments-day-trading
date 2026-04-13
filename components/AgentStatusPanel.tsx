"use client";

import { useCallback, useEffect, useState } from "react";

// ─── Types (mirrors API response shapes) ────────────────────────────

interface QueueCounts {
  openCount: number;
  executionReadyCount: number;
  inProgressCount: number;
  blockedCount: number;
  selectedCount: number;
}

interface ActiveTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  taskType: string;
  executionReady: boolean;
  createdAt: string;
  blockedReason?: string | null;
  latestExecutionResult?: {
    ok: boolean;
    summary?: string;
    commitSha?: string | null;
    error?: string | null;
    finishedAt?: string;
  } | null;
}

interface CriticalIncident {
  id: string;
  title?: string;
  category?: string;
  blocking?: boolean;
}

interface BriefResponse {
  ok: boolean;
  criticalIncidents?: {
    count: number;
    blockingCount: number;
    topIncidents: CriticalIncident[];
  };
  manualQueue?: {
    openCount: number;
    executionReadyCount: number;
    inProgressCount: number;
    blockedCount: number;
    selectedCount: number;
    topTasks: ActiveTask[];
    latestExecution?: ActiveTask | null;
  };
  executionAutonomy?: {
    canAutoExecute: boolean;
    reason?: string;
  };
}

interface StateResponse {
  ok: boolean;
  state?: {
    posture?: string;
    eventRisk?: string;
    activeIncidentCount?: number;
  };
  manualQueue?: {
    activeManualTask: ActiveTask | null;
    queueCounts: QueueCounts;
  };
  latestExecution?: {
    taskTitle?: string;
    status?: string;
    commitSha?: string | null;
    summary?: string;
  };
}

// ─── Sub-components ─────────────────────────────────────────────────

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  const bg: Record<string, string> = {
    red: "bg-red-900/30 text-red-300 border-red-700/40",
    yellow: "bg-yellow-900/30 text-yellow-300 border-yellow-700/40",
    green: "bg-emerald-900/30 text-emerald-300 border-emerald-700/40",
    blue: "bg-blue-900/30 text-blue-300 border-blue-700/40",
    neutral: "bg-neutral-800/50 text-neutral-300 border-neutral-700/40",
  };
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${bg[color] || bg.neutral}`}>
      {children}
    </span>
  );
}

function StatusRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1">
      <span className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)] shrink-0">
        {label}
      </span>
      <span className="text-xs text-neutral-200 text-right">{value}</span>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────

export function AgentStatusPanel() {
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [agentState, setAgentState] = useState<StateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [briefRes, stateRes] = await Promise.allSettled([
        fetch("/api/agents/brief", { cache: "no-store" }),
        fetch("/api/agents/state", { cache: "no-store" }),
      ]);
      if (briefRes.status === "fulfilled" && briefRes.value.ok) {
        setBrief(await briefRes.value.json().catch(() => null));
      }
      if (stateRes.status === "fulfilled" && stateRes.value.ok) {
        setAgentState(await stateRes.value.json().catch(() => null));
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 15_000);
    return () => clearInterval(iv);
  }, [load]);

  const triggerExecution = useCallback(async () => {
    setTriggering(true);
    setTriggerResult(null);
    try {
      const res = await fetch("/api/agents/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (res.ok) {
        setTriggerResult("Execution triggered");
        // Refresh state after short delay
        setTimeout(load, 3_000);
      } else {
        const body = await res.json().catch(() => ({}));
        setTriggerResult(`Failed: ${(body as Record<string, string>).error || res.status}`);
      }
    } catch {
      setTriggerResult("Network error");
    } finally {
      setTriggering(false);
    }
  }, [load]);

  // Derived state
  const criticals = brief?.criticalIncidents;
  const hasBlockingIncident = (criticals?.blockingCount ?? 0) > 0;
  const manualQ = agentState?.manualQueue;
  const activeTask = manualQ?.activeManualTask;
  const counts = manualQ?.queueCounts;
  const latestExec = agentState?.latestExecution;
  const posture = agentState?.state?.posture ?? "NORMAL";

  return (
    <div className="space-y-4">
      {/* Loading */}
      {loading && (
        <div className="text-xs text-[var(--ci-text-muted)] animate-pulse">Loading agent status…</div>
      )}

      {/* Critical blocker banner */}
      {hasBlockingIncident && (
        <div className="rounded-xl border border-red-700/50 bg-red-900/20 px-4 py-3 space-y-1">
          <div className="text-xs font-semibold text-red-300">
            Blocked by critical incident ({criticals!.blockingCount} blocking)
          </div>
          {criticals!.topIncidents
            .filter((i) => i.blocking)
            .slice(0, 3)
            .map((i) => (
              <div key={i.id} className="text-[11px] text-red-200/80">
                • {i.title ?? i.category ?? i.id.slice(0, 8)}
              </div>
            ))}
          <div className="text-[10px] text-red-300/60 mt-1">
            Execution is paused until blocking incidents are resolved.
          </div>
        </div>
      )}

      {/* System posture */}
      <div className="flex items-center gap-2">
        <Pill
          color={
            posture === "DEFENSIVE" ? "red"
            : posture === "AGGRESSIVE" ? "yellow"
            : "green"
          }
        >
          {posture}
        </Pill>
        <Pill color={agentState?.state?.eventRisk === "HIGH" ? "red" : "neutral"}>
          Risk: {agentState?.state?.eventRisk ?? "LOW"}
        </Pill>
        {(agentState?.state?.activeIncidentCount ?? 0) > 0 && (
          <Pill color="yellow">
            {agentState!.state!.activeIncidentCount} incident{agentState!.state!.activeIncidentCount! > 1 ? "s" : ""}
          </Pill>
        )}
      </div>

      {/* Queue summary */}
      {counts && (
        <div className="rounded-xl border border-[var(--ci-border)] bg-black/20 px-4 py-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)] mb-2">
            Manual queue
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatusRow label="Open" value={counts.openCount} />
            <StatusRow label="Ready" value={counts.executionReadyCount} />
            <StatusRow label="Running" value={counts.inProgressCount} />
            <StatusRow label="Blocked" value={counts.blockedCount} />
          </div>
        </div>
      )}

      {/* Active task */}
      {activeTask && (
        <div className="rounded-xl border border-blue-700/30 bg-blue-900/10 px-4 py-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-blue-300/70">
            Active task
          </div>
          <div className="text-sm text-neutral-100 font-medium">
            {activeTask.title}
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill color="blue">{activeTask.status}</Pill>
            <Pill color="neutral">{activeTask.priority}</Pill>
            <Pill color="neutral">{activeTask.taskType}</Pill>
          </div>
          {activeTask.blockedReason && (
            <div className="text-xs text-yellow-300 mt-1">
              Blocked: {activeTask.blockedReason}
            </div>
          )}
          {activeTask.latestExecutionResult && (
            <div className="text-xs mt-1">
              <span className={activeTask.latestExecutionResult.ok ? "text-green-400" : "text-red-300"}>
                {activeTask.latestExecutionResult.ok ? "Success" : "Failed"}
              </span>
              {activeTask.latestExecutionResult.summary && (
                <span className="text-neutral-400 ml-1">
                  — {activeTask.latestExecutionResult.summary.slice(0, 120)}
                </span>
              )}
              {activeTask.latestExecutionResult.commitSha && (
                <span className="text-neutral-500 ml-1 font-mono text-[10px]">
                  {activeTask.latestExecutionResult.commitSha.slice(0, 7)}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Latest execution result (when no active task) */}
      {!activeTask && latestExec?.taskTitle && (
        <div className="rounded-xl border border-[var(--ci-border)] bg-black/20 px-4 py-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
            Latest execution
          </div>
          <div className="text-xs text-neutral-200">{latestExec.taskTitle}</div>
          <div className="flex flex-wrap gap-2 text-[10px]">
            <Pill color={latestExec.status === "DONE" ? "green" : "neutral"}>
              {latestExec.status ?? "—"}
            </Pill>
            {latestExec.commitSha && (
              <span className="font-mono text-neutral-500">
                {latestExec.commitSha.slice(0, 7)}
              </span>
            )}
          </div>
          {latestExec.summary && (
            <div className="text-[11px] text-neutral-400 mt-0.5">
              {latestExec.summary.slice(0, 200)}
            </div>
          )}
        </div>
      )}

      {/* Run now button */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={triggerExecution}
          disabled={triggering || hasBlockingIncident}
          className="rounded-lg border border-[var(--ci-border)] bg-black/30 px-4 py-2 text-xs text-neutral-300 hover:bg-white/5 active:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {triggering ? "Running…" : hasBlockingIncident ? "Blocked" : "Run now"}
        </button>
        <button
          type="button"
          onClick={load}
          className="rounded-lg border border-[var(--ci-border)] bg-black/30 px-3 py-2 text-xs text-neutral-400 hover:bg-white/5 transition-colors"
        >
          Refresh
        </button>
        {triggerResult && (
          <span className={`text-xs ${triggerResult.startsWith("Failed") ? "text-red-300" : "text-green-400"}`}>
            {triggerResult}
          </span>
        )}
      </div>

      {/* Brief queue top tasks */}
      {brief?.manualQueue?.topTasks && brief.manualQueue.topTasks.length > 0 && (
        <div className="rounded-xl border border-[var(--ci-border)] bg-black/20 px-4 py-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
            Queue preview
          </div>
          {brief.manualQueue.topTasks.slice(0, 5).map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-xs">
              <Pill
                color={
                  t.status === "IN_PROGRESS" ? "blue"
                  : t.status === "BLOCKED" ? "red"
                  : t.executionReady ? "green"
                  : "neutral"
                }
              >
                {t.status}
              </Pill>
              <span className="text-neutral-300 truncate">{t.title}</span>
              <span className="text-[10px] text-neutral-500 ml-auto shrink-0">
                {t.priority}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
