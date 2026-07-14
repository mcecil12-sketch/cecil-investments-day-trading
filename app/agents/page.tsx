import { prisma } from "@/lib/prisma";
import type { AgentType } from "@/lib/generated/prisma";
import type { RelativeStrengthEntry, RelativeStrengthOutput } from "@/lib/agents/relativeStrength";
import { alphaColor, formatCurrency, formatDate, formatDateTime, formatPercent } from "@/lib/format";
import { RunAgentButton } from "./RunAgentButton";

export const dynamic = "force-dynamic";

interface AgentDefinition {
  type: AgentType;
  name: string;
  implemented: boolean;
  endpoint?: string;
}

const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    type: "RELATIVE_STRENGTH",
    name: "Relative Strength",
    implemented: true,
    endpoint: "/api/agents/relative-strength",
  },
  { type: "SECTOR_ROTATION", name: "Sector Rotation", implemented: false },
  { type: "RISK_MANAGER", name: "Risk Manager", implemented: false },
];

function renderTable(title: string, entries: RelativeStrengthEntry[]) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>{title}</div>
      {entries.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>None.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Score</th>
                <th>vs S&amp;P</th>
                <th>Momentum (1Y)</th>
                <th>Trend</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.symbol}>
                  <td>
                    {entry.symbol}
                    {entry.note && (
                      <div style={{ color: "var(--text-muted)", fontSize: "0.72rem", fontWeight: 400 }}>
                        {entry.note}
                      </div>
                    )}
                  </td>
                  <td className="mono">{entry.score}</td>
                  <td className="mono" style={{ color: alphaColor(entry.relativeScore) }}>
                    {entry.relativeScore > 0 ? "+" : ""}
                    {entry.relativeScore}
                  </td>
                  <td className="mono">{formatPercent(entry.momentum)}</td>
                  <td className="mono" style={{ color: "var(--text-muted)" }}>
                    {entry.aboveSma50 == null ? "—" : entry.aboveSma50 ? "Above 50d" : "Below 50d"}
                    {" / "}
                    {entry.aboveSma200 == null ? "—" : entry.aboveSma200 ? "Above 200d" : "Below 200d"}
                  </td>
                  <td className="mono">{formatCurrency(entry.currentValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default async function AgentsPage() {
  const [weeklyBrief, latestRuns] = await Promise.all([
    prisma.weeklyBrief.findFirst({
      orderBy: { weekOf: "desc" },
      include: { actionItems: { orderBy: { priority: "asc" }, include: { account: true } } },
    }),
    Promise.all(
      AGENT_DEFINITIONS.map((def) =>
        prisma.agentRun.findFirst({
          where: { agentType: def.type },
          orderBy: { startedAt: "desc" },
          include: {
            actionItems: { orderBy: { priority: "asc" }, take: 3, include: { account: true } },
          },
        }),
      ),
    ),
  ]);

  let cioItems = weeklyBrief?.actionItems ?? null;
  let cioIsFallback = false;
  if (!cioItems || cioItems.length === 0) {
    const latestRunWithItems = await prisma.agentRun.findFirst({
      where: { status: "COMPLETE", actionItems: { some: {} } },
      orderBy: { startedAt: "desc" },
      include: { actionItems: { orderBy: { priority: "asc" }, include: { account: true } } },
    });
    if (latestRunWithItems) {
      cioItems = latestRunWithItems.actionItems;
      cioIsFallback = true;
    }
  }

  const hasAnyRun = latestRuns.some((run) => run != null);

  return (
    <div>
      <h1>Agents</h1>

      <div className="card card-accent">
        <div className="agent-card-header">
          <strong>CIO Weekly Action List</strong>
          {weeklyBrief && (
            <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
              Week of {formatDate(weeklyBrief.weekOf)}
            </span>
          )}
        </div>
        {weeklyBrief?.cioSummary && (
          <p style={{ color: "var(--text-muted)", marginTop: 0 }}>{weeklyBrief.cioSummary}</p>
        )}
        {!cioItems || cioItems.length === 0 ? (
          <p style={{ color: "var(--text-muted)" }}>
            {hasAnyRun
              ? "No action items yet."
              : "No agent has run yet — action items will appear here automatically after your next import, or run an agent below."}
          </p>
        ) : (
          <div>
            {cioIsFallback && (
              <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginBottom: "0.5rem" }}>
                No weekly brief compiled yet — showing the latest agent run&apos;s recommendations.
              </p>
            )}
            {cioItems.map((item) => (
              <div className="action-item-row" key={item.id}>
                <div className="action-item-priority">{item.priority}</div>
                <div className="action-item-body">
                  <div className="action-item-action">{item.action}</div>
                  <div className="action-item-rationale">{item.rationale}</div>
                  <div className="action-item-rationale">
                    {item.expectedImpact}
                    {item.account ? ` — ${item.account.name}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="agent-grid">
        {AGENT_DEFINITIONS.map((def, i) => {
          const run = latestRuns[i];
          const status = !run ? "idle" : run.status.toLowerCase();

          return (
            <div className="card" key={def.type} id={`agent-${def.type.toLowerCase()}`}>
              <div className="agent-card-header">
                <span className="agent-card-name">{def.name}</span>
                <span className={`status-pill status-${status}`}>{status}</span>
              </div>
              <div className="agent-last-run">
                {run
                  ? `Last run ${formatDateTime(run.completedAt ?? run.startedAt)}`
                  : def.implemented
                    ? "Never run"
                    : "Not yet built"}
              </div>

              {run && run.actionItems.length > 0 ? (
                <div>
                  {run.actionItems.map((item) => (
                    <div className="finding-row" key={item.id}>
                      <span className="finding-symbol">{item.action}</span>
                      <span className="finding-detail">{item.rationale}</span>
                    </div>
                  ))}
                </div>
              ) : (
                def.implemented && (
                  <p style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>No findings yet.</p>
                )
              )}

              {def.implemented && run && run.status === "COMPLETE" && (
                <a
                  className="link-back"
                  href={`#report-${def.type.toLowerCase()}`}
                  style={{ display: "inline-block", marginTop: "0.5rem" }}
                >
                  View Full Report →
                </a>
              )}

              {def.implemented && <RunAgentButton endpoint={def.endpoint!} />}
            </div>
          );
        })}
      </div>

      {latestRuns.map((run, i) => {
        const def = AGENT_DEFINITIONS[i];
        if (!run || !def.implemented || run.status !== "COMPLETE" || !run.output) return null;
        const output = run.output as unknown as RelativeStrengthOutput;

        return (
          <div key={def.type} id={`report-${def.type.toLowerCase()}`}>
            <h2>{def.name} — Full Report</h2>
            <div className="card">
              <p style={{ color: "var(--text-muted)" }}>
                S&amp;P 500 baseline: score {output.sp500.score}/100 · 52-week momentum{" "}
                {formatPercent(output.sp500.momentum)}
              </p>
              {renderTable("Top Holdings", output.topHoldings)}
              {renderTable("Underperformers", output.underperformers)}
              {renderTable("Candidates to Watch", output.candidates)}
              {output.skipped.length > 0 && (
                <div style={{ marginTop: "0.5rem" }}>
                  <div style={{ fontWeight: 600, marginBottom: "0.4rem", fontSize: "0.85rem" }}>Skipped</div>
                  <ul style={{ margin: 0, paddingLeft: "1.2rem", color: "var(--text-muted)", fontSize: "0.78rem" }}>
                    {output.skipped.map((s) => (
                      <li key={s.symbol}>
                        {s.symbol}: {s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
