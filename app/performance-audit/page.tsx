import { prisma } from "@/lib/prisma";
import { refreshRecommendationOutcomes } from "@/lib/agents/performanceAudit";
import { refreshCandidateRecommendationOutcomes } from "@/lib/agents/candidateRecommendationLog";
import { formatDate, formatPercent, alphaColor } from "@/lib/format";
import { OutcomeControls } from "./OutcomeControls";

export const dynamic = "force-dynamic";

interface OutcomeRow {
  weeklyBriefId: string;
  weekOf: Date;
  actionItemIndex: number;
  action: string;
  rationale: string;
  executed: boolean | null;
  notes: string;
  outcome30d: number | null;
  outcome90d: number | null;
}

function winRate(rows: OutcomeRow[], field: "outcome30d" | "outcome90d"): { wins: number; total: number } {
  const evaluated = rows.filter((r) => r.executed && r[field] != null);
  const wins = evaluated.filter((r) => (r[field] as number) > 0).length;
  return { wins, total: evaluated.length };
}

function winRateLabel(rate: { wins: number; total: number }): string {
  if (rate.total === 0) return "No executed recommendations old enough to score yet";
  return `${Math.round((rate.wins / rate.total) * 100)}% (${rate.wins}/${rate.total}) vs S&P 500`;
}

export default async function PerformanceAuditPage() {
  try {
    await refreshRecommendationOutcomes();
  } catch (err) {
    console.error("refreshRecommendationOutcomes failed:", err);
  }

  try {
    await refreshCandidateRecommendationOutcomes();
  } catch (err) {
    console.error("refreshCandidateRecommendationOutcomes failed:", err);
  }

  const weeklyBriefs = await prisma.weeklyBrief.findMany({
    orderBy: { weekOf: "desc" },
    include: {
      actionItems: { orderBy: { priority: "asc" } },
      recommendationOutcomes: true,
    },
  });

  const rows: OutcomeRow[] = weeklyBriefs.flatMap((brief) =>
    brief.actionItems.map((item) => {
      const outcome = brief.recommendationOutcomes.find((o) => o.actionItemIndex === item.priority);
      return {
        weeklyBriefId: brief.id,
        weekOf: brief.weekOf,
        actionItemIndex: item.priority,
        action: item.action,
        rationale: item.rationale,
        executed: outcome?.executed ?? null,
        notes: outcome?.notes ?? "",
        outcome30d: outcome?.outcome30d ?? null,
        outcome90d: outcome?.outcome90d ?? null,
      };
    }),
  );

  const rate30 = winRate(rows, "outcome30d");
  const rate90 = winRate(rows, "outcome90d");

  return (
    <div>
      <h1>Performance Audit Trail</h1>
      <p style={{ color: "var(--text-muted)" }}>
        Every CIO recommendation, timestamped, with what was actually done and how it performed — the track record
        foundation for productization.
      </p>

      <div className="period-cards">
        <div className="card">
          <div className="period-card-label">30-Day Win Rate</div>
          <div className="period-card-alpha" style={{ color: rate30.total > 0 ? alphaColor(rate30.wins - rate30.total / 2) : undefined }}>
            {winRateLabel(rate30)}
          </div>
        </div>
        <div className="card">
          <div className="period-card-label">90-Day Win Rate</div>
          <div className="period-card-alpha" style={{ color: rate90.total > 0 ? alphaColor(rate90.wins - rate90.total / 2) : undefined }}>
            {winRateLabel(rate90)}
          </div>
        </div>
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <p style={{ color: "var(--text-muted)" }}>
            No CIO recommendations yet — this fills in once the weekly brief has run.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Recommendation</th>
                  <th>Action Taken</th>
                  <th>30-Day Outcome</th>
                  <th>90-Day Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.weeklyBriefId}-${row.actionItemIndex}`}>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>{formatDate(row.weekOf)}</td>
                    <td style={{ minWidth: "16rem" }}>
                      <div style={{ fontWeight: 600 }}>{row.action}</div>
                      <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>{row.rationale}</div>
                    </td>
                    <td style={{ minWidth: "12rem" }}>
                      <OutcomeControls
                        weeklyBriefId={row.weeklyBriefId}
                        actionItemIndex={row.actionItemIndex}
                        initialExecuted={row.executed}
                        initialNotes={row.notes}
                      />
                    </td>
                    <td className="mono" style={{ color: alphaColor(row.outcome30d) }}>
                      {row.outcome30d == null ? "Pending" : formatPercent(row.outcome30d)}
                    </td>
                    <td className="mono" style={{ color: alphaColor(row.outcome90d) }}>
                      {row.outcome90d == null ? "Pending" : formatPercent(row.outcome90d)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
