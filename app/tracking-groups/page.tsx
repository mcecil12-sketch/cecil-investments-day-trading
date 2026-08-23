import { prisma } from "@/lib/prisma";
import { listZeroMissMonths } from "@/lib/agents/zeroMissAggregation";
import { getRecommendationPerformance, groupIntoMonthlyRankings } from "@/lib/agents/recommendationPerformance";
import {
  buildBandedMonthlyPositions,
  currentlyHeldSymbols,
  BUY_RANK_THRESHOLD,
  SELL_RANK_THRESHOLD,
  TARGET_PORTFOLIO_SIZE,
  MAX_PORTFOLIO_SIZE,
} from "@/lib/agents/monthlyScanBanding";
import type { MonthlyScanOutput } from "@/lib/agents/monthlyScan";
import type { SectorRotationOutput } from "@/lib/agents/sectorRotation";
import { RecommendationPerformanceCharts, type PickQualityChartPoint } from "@/app/dashboard/RecommendationPerformanceCharts";
import { formatDateTime, formatPercent } from "@/lib/format";
import type { TimeframeKey } from "@/lib/timeframes";

export const dynamic = "force-dynamic";

async function getGroup1Summary() {
  const run = await prisma.agentRun.findFirst({
    where: { agentType: "CANDIDATE_SCANNER", status: "COMPLETE" },
    orderBy: { startedAt: "desc" },
    select: { completedAt: true, startedAt: true },
  });
  return { lastRunAt: run?.completedAt ?? run?.startedAt ?? null };
}

async function getGroup3State() {
  const [rows, sectorRun, cronRuns] = await Promise.all([
    prisma.candidateRecommendationLog.findMany({ where: { group: "GROUP_3" }, orderBy: { recommendedAt: "asc" } }),
    prisma.agentRun.findFirst({ where: { agentType: "SECTOR_ROTATION", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findMany({
      where: { agentType: "MONTHLY_SCAN", status: "COMPLETE" },
      orderBy: { startedAt: "asc" },
      select: { completedAt: true, startedAt: true, output: true },
    }),
  ]);

  const monthlyRankings = groupIntoMonthlyRankings(rows);
  const positions = buildBandedMonthlyPositions(monthlyRankings);
  const heldSymbols = currentlyHeldSymbols(monthlyRankings);
  const latestMonth = monthlyRankings[monthlyRankings.length - 1] ?? null;
  const soldThisMonth = latestMonth
    ? positions.filter((p) => p.exitDate?.getTime() === latestMonth.date.getTime()).map((p) => p.symbol)
    : [];

  const firstLiveRun =
    cronRuns.find((r) => (r.output as unknown as MonthlyScanOutput | null)?.triggerSource === "cron") ?? null;

  const sectorFlags = sectorRun?.output ? (sectorRun.output as unknown as SectorRotationOutput).flags : [];
  const sectorFlagsAsOf = sectorRun?.output ? (sectorRun.output as unknown as SectorRotationOutput).generatedAt : null;

  const performance = await getRecommendationPerformance(null, "GROUP_3");

  return { latestMonth, heldSymbols, soldThisMonth, firstLiveRun, sectorFlags, sectorFlagsAsOf, performance };
}

function chartProps(performance: Awaited<ReturnType<typeof getRecommendationPerformance>>) {
  return {
    pickQualityByTimeframe: Object.fromEntries(
      Object.entries(performance.pickQualityByTimeframe).map(([key, points]) => [
        key,
        points.map((p) => ({
          date: p.date.toISOString().slice(0, 10),
          pickReturn: p.pickReturn,
          spxReturn: p.spxReturn,
          activeCount: p.activeCount,
        })),
      ]),
    ) as Record<TimeframeKey, PickQualityChartPoint[]>,
    simulatedPortfolio: performance.simulatedPortfolio.map((p) => ({
      date: p.date.toISOString().slice(0, 10),
      portfolioValue: p.portfolioValue,
      pnl: p.pnl,
      pnlPct: p.pnlPct,
      activeCount: p.activeCount,
    })),
    baseValue: performance.baseValue,
    trackedSince: performance.trackedSince ? performance.trackedSince.toISOString() : null,
    totalPositions: performance.totalPositions,
  };
}

function renderZeroMissSection(months: Awaited<ReturnType<typeof listZeroMissMonths>>) {
  if (months.length === 0) {
    return <p style={{ color: "var(--text-muted)" }}>No weekly Candidate Scanner batches logged yet.</p>;
  }
  return (
    <>
      {months.map((m) => (
        <div key={m.monthKey} style={{ marginBottom: "1rem" }}>
          <div className="agent-card-header" style={{ marginBottom: "0.3rem" }}>
            <span className="agent-card-name" style={{ fontSize: "0.9rem" }}>{m.monthKey}</span>
            <span
              className={`status-pill ${m.isCurrentMonth ? "status-running" : "status-complete"}`}
              style={{ fontSize: "0.7rem" }}
            >
              {m.isCurrentMonth ? "IN PROGRESS" : "COMPLETE"}
            </span>
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginTop: 0 }}>
            Checked against {m.snapshotCount} weekly snapshot{m.snapshotCount === 1 ? "" : "s"}
            {m.isCurrentMonth ? " so far this month." : " this month."}
          </p>
          {m.qualifyingSymbols.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>No zero-miss symbols.</p>
          ) : (
            <p style={{ fontSize: "0.85rem" }}>
              {m.qualifyingSymbols.map((q) => q.symbol).join(", ")}
            </p>
          )}
        </div>
      ))}
    </>
  );
}

export default async function TrackingGroupsPage() {
  const [group1, group2Months, group3] = await Promise.all([
    getGroup1Summary(),
    listZeroMissMonths(),
    getGroup3State(),
  ]);

  return (
    <div>
      <h1>Recommendation Tracking Groups</h1>
      <p style={{ color: "var(--text-muted)" }}>
        Three parallel, independently-tracked recommendation lenses (see docs/recommendation-tracking-groups.md for
        the full evaluation ground rules) — no group is declared &quot;better&quot; based on early results; minimum
        evaluation horizon is 3-6 months, ideally a full year.
      </p>

      <div className="card card-accent">
        <div className="agent-card-header">
          <strong>Group 1 — Weekly Candidate Scanner</strong>
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
          Unchanged. Research/observation only, not tied to any live account.
          {group1.lastRunAt && <> Last run {formatDateTime(group1.lastRunAt)}.</>}
        </p>
        <a href="/recommendations" className="link-back">
          View Recommendations →
        </a>
      </div>

      <div className="card">
        <div className="agent-card-header">
          <strong>Group 2 — Zero-Miss Monthly Aggregation</strong>
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginTop: 0 }}>
          Symbols present in every weekly Group 1 snapshot within a calendar month. Research/tracking only — never
          used for live trading decisions.
        </p>
        {renderZeroMissSection(group2Months)}
      </div>

      <div className="card">
        <div className="agent-card-header">
          <strong>Group 3 — Monthly Scan (Rank-Banded)</strong>
        </div>
        {group3.firstLiveRun ? (
          <p style={{ color: "var(--positive)", fontSize: "0.85rem", marginTop: 0 }}>
            Group 3 trading-ready as of {formatDateTime(group3.firstLiveRun.completedAt ?? group3.firstLiveRun.startedAt)}.
            For Kennedy Account — reference for manual trade decisions only, not automated execution.
          </p>
        ) : (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginTop: 0 }}>
            Not yet trading-ready — awaiting first live monthly cycle (runs on the 1st of each month).
          </p>
        )}
        <p style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>
          Buy rank ≤ {BUY_RANK_THRESHOLD}, sell rank &gt; {SELL_RANK_THRESHOLD}, target size {TARGET_PORTFOLIO_SIZE},
          cap {MAX_PORTFOLIO_SIZE}.
        </p>

        {group3.sectorFlags.length > 0 && (
          <div style={{ marginBottom: "1rem" }}>
            <div style={{ fontWeight: 600, marginBottom: "0.4rem", fontSize: "0.85rem" }}>
              Sector Risk Flags (live, weekly cadence — independent of Group 3&apos;s monthly cycle)
              {group3.sectorFlagsAsOf && (
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> — as of {formatDateTime(new Date(group3.sectorFlagsAsOf))}</span>
              )}
            </div>
            {group3.sectorFlags.map((f, i) => (
              <div className="finding-row" key={i}>
                <span className="finding-symbol">{f.sector}</span>
                <span className="finding-detail">{f.detail}</span>
              </div>
            ))}
          </div>
        )}

        {!group3.latestMonth ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>No monthly scan run yet.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Symbol</th>
                    <th>Score</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {group3.latestMonth.rankedSymbols.map((s, i) => {
                    const rank = i + 1;
                    const held = group3.heldSymbols.has(s.symbol);
                    const status = held ? "HELD" : rank <= BUY_RANK_THRESHOLD ? "BUY (no room)" : "—";
                    return (
                      <tr key={s.symbol}>
                        <td className="mono">{rank}</td>
                        <td>{s.symbol}</td>
                        <td className="mono">{s.score}</td>
                        <td className="mono" style={{ color: held ? "var(--positive)" : undefined }}>{status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {group3.soldThisMonth.length > 0 && (
              <p style={{ color: "var(--negative)", fontSize: "0.8rem", marginTop: "0.5rem" }}>
                Sold this month: {group3.soldThisMonth.join(", ")}
              </p>
            )}
          </>
        )}

        {group3.performance.totalPositions > 0 && (
          <div style={{ marginTop: "1rem" }}>
            <RecommendationPerformanceCharts {...chartProps(group3.performance)} />
          </div>
        )}
      </div>
    </div>
  );
}
