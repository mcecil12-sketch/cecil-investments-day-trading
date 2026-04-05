"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentBrief, AgentState } from "@/lib/agents/types";

type AgentStateResponse = {
  ok?: boolean;
  state?: AgentState;
};

type AgentBriefResponse = {
  ok?: boolean;
  brief?: AgentBrief | null;
};

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--ci-border)] bg-black/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
        {label}
      </div>
      <div className="mt-1 text-sm text-neutral-100">{value}</div>
    </div>
  );
}

function formatMaxEntries(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "No override";
}

export function AgentControlCard() {
  const [state, setState] = useState<AgentState | null>(null);
  const [brief, setBrief] = useState<AgentBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [stateResult, briefResult] = await Promise.allSettled([
        fetch("/api/agents/state", { cache: "no-store" }),
        fetch("/api/agents/brief/latest", { cache: "no-store" }),
      ]);

      if (stateResult.status === "fulfilled" && stateResult.value.ok) {
        const payload = (await stateResult.value.json().catch(() => ({}))) as AgentStateResponse;
        setState(payload.state ?? null);
      }

      if (briefResult.status === "fulfilled" && briefResult.value.ok) {
        const payload = (await briefResult.value.json().catch(() => ({}))) as AgentBriefResponse;
        setBrief(payload.brief ?? null);
      }

      const failed =
        (stateResult.status === "rejected" ||
          (stateResult.status === "fulfilled" && !stateResult.value.ok)) &&
        (briefResult.status === "rejected" ||
          (briefResult.status === "fulfilled" && !briefResult.value.ok));

      setError(failed ? "Agent control unavailable" : null);
    } catch {
      setError("Agent control unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <section className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 md:p-6 shadow-[0_0_12px_rgba(255,255,255,0.03)] space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-100">Agent control</h2>
          <p className="text-[11px] text-neutral-500">
            Day-1 control plane status for PM, Risk, Ops, PolicyNews, and Engineering.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
          {loading ? "Loading" : "Live"}
        </div>
      </div>

      {error && !state && <p className="text-xs text-[var(--ci-negative)]">{error}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <DetailRow label="Posture" value={state?.posture ?? "NORMAL"} />
        <DetailRow label="Event risk" value={state?.eventRisk ?? "LOW"} />
        <DetailRow label="News state" value={state?.newsState ?? "CALM"} />
        <DetailRow label="Allowed grades" value={state?.allowedGrades?.join(" / ") || "A / B / C"} />
        <DetailRow label="Min score adjustment" value={String(state?.minScoreAdjustment ?? 0)} />
        <DetailRow label="Max entries override" value={formatMaxEntries(state?.maxEntriesOverride)} />
        <DetailRow label="Freeze windows" value={String(state?.freezeWindows?.length ?? 0)} />
        <DetailRow label="Active incidents" value={String(state?.activeIncidentCount ?? 0)} />
      </div>

      <div className="rounded-xl border border-[var(--ci-border)] bg-black/20 px-4 py-3 space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
          Active restrictions
        </div>
        <div className="text-xs text-neutral-200">
          {state?.activeRestrictions?.length
            ? state.activeRestrictions.join("; ")
            : "No active restrictions"}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <DetailRow
          label="Recent pending"
          value={String(state?.telemetry?.recentSignalsPending ?? 0)}
        />
        <DetailRow
          label="Recent scored"
          value={String(state?.telemetry?.recentSignalsScored ?? 0)}
        />
        <DetailRow
          label="Recent zero scores"
          value={String(state?.telemetry?.recentZeroScores ?? 0)}
        />
        <DetailRow
          label="Readiness"
          value={state?.telemetry?.readinessReady === false ? "DEGRADED" : "READY"}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        <DetailRow
          label="Open incident categories"
          value={
            state?.openIncidentCategories?.length
              ? state.openIncidentCategories.join(" / ")
              : "None"
          }
        />
        <DetailRow
          label="Open engineering tasks"
          value={String(state?.openEngineeringTaskCount ?? 0)}
        />
        <DetailRow
          label="Latest engineering task"
          value={state?.latestEngineeringTaskTitle ?? "None"}
        />
      </div>

      {state?.remediationSummary && (
        <div className="rounded-xl border border-[var(--ci-border)] bg-black/20 px-4 py-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
            Latest remediation
          </div>
          <div className="text-xs text-neutral-200">{state.remediationSummary}</div>
        </div>
      )}

      <div className="rounded-xl border border-[var(--ci-border)] bg-black/20 px-4 py-3 space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
          Latest brief
        </div>
        <div className="text-sm text-neutral-100">
          {brief?.title ?? "No agent brief published yet"}
        </div>
        <div className="text-xs text-[var(--ci-text-muted)]">
          {brief?.summary ?? "Safe defaults are active until the first runner publishes a status brief."}
        </div>
      </div>
    </section>
  );
}