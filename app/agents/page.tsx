import type { ReactNode } from "react";
import { prisma } from "@/lib/prisma";
import type { AgentType } from "@/lib/generated/prisma";
import type { RelativeStrengthEntry, RelativeStrengthOutput } from "@/lib/agents/relativeStrength";
import type { SectorRotationOutput } from "@/lib/agents/sectorRotation";
import type { RiskManagerOutput, RiskFlag } from "@/lib/agents/riskManager";
import { alphaColor, formatCurrency, formatDate, formatDateTime, formatPercent } from "@/lib/format";
import { RunAgentButton } from "./RunAgentButton";
import { AgentStatusPoller } from "./AgentStatusPoller";
import type { AgentStatusResponse } from "@/app/api/agents/status/route";

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
  {
    type: "SECTOR_ROTATION",
    name: "Sector Rotation",
    implemented: true,
    endpoint: "/api/agents/sector-rotation",
  },
  {
    type: "RISK_MANAGER",
    name: "Risk Manager",
    implemented: true,
    endpoint: "/api/agents/risk-manager",
  },
];

function renderRelativeStrengthTable(title: string, entries: RelativeStrengthEntry[]) {
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
                <th>YTD</th>
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
                    {entry.divergenceFlag && (
                      <div style={{ color: "var(--negative)", fontSize: "0.72rem", fontWeight: 600 }}>
                        {entry.divergenceFlag}
                      </div>
                    )}
                  </td>
                  <td className="mono">{entry.score}</td>
                  <td className="mono" style={{ color: alphaColor(entry.relativeScore) }}>
                    {entry.relativeScore > 0 ? "+" : ""}
                    {entry.relativeScore}
                  </td>
                  <td className="mono" style={{ color: alphaColor(entry.ytdReturn) }}>
                    {formatPercent(entry.ytdReturn)}
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

function renderSkipped(skipped: Array<{ symbol: string; reason: string }>) {
  if (skipped.length === 0) return null;
  return (
    <div style={{ marginTop: "0.5rem" }}>
      <div style={{ fontWeight: 600, marginBottom: "0.4rem", fontSize: "0.85rem" }}>Skipped</div>
      <ul style={{ margin: 0, paddingLeft: "1.2rem", color: "var(--text-muted)", fontSize: "0.78rem" }}>
        {skipped.map((s) => (
          <li key={s.symbol}>
            {s.symbol}: {s.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderRelativeStrengthReport(output: RelativeStrengthOutput) {
  return (
    <div className="card">
      <p style={{ color: "var(--text-muted)" }}>
        S&amp;P 500 baseline: score {output.sp500.score}/100 · 52-week momentum {formatPercent(output.sp500.momentum)}
      </p>
      {renderRelativeStrengthTable("Top Holdings", output.topHoldings)}
      {renderRelativeStrengthTable("Underperformers", output.underperformers)}
      {renderRelativeStrengthTable("Candidates to Watch", output.candidates)}
      {renderRelativeStrengthTable("All Scored Positions", output.allHoldings ?? [])}
      {renderSkipped(output.skipped)}
    </div>
  );
}

function renderSectorRotationReport(output: SectorRotationOutput) {
  return (
    <div className="card">
      <p style={{ color: "var(--text-muted)" }}>
        S&amp;P 500 baseline: score {output.sp500.score}/100 · 1M {formatPercent(output.sp500.oneMonth)} · 3M{" "}
        {formatPercent(output.sp500.threeMonth)} · 12M {formatPercent(output.sp500.twelveMonth)}
      </p>

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>Ranked Sectors</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Sector</th>
                <th>Symbol</th>
                <th>1M</th>
                <th>3M</th>
                <th>12M</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {output.rankedSectors.map((s) => (
                <tr key={s.symbol}>
                  <td className="mono">{s.rank}</td>
                  <td>{s.sector}</td>
                  <td className="mono">{s.symbol}</td>
                  <td className="mono">{formatPercent(s.oneMonth)}</td>
                  <td className="mono">{formatPercent(s.threeMonth)}</td>
                  <td className="mono">{formatPercent(s.twelveMonth)}</td>
                  <td className="mono">{s.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>Portfolio Sector Exposure</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Sector</th>
                <th>Value</th>
                <th>% of Portfolio</th>
                <th>Rotation Score</th>
              </tr>
            </thead>
            <tbody>
              {output.portfolioExposure.map((e) => (
                <tr key={e.sector}>
                  <td>{e.sector}</td>
                  <td className="mono">{formatCurrency(e.value)}</td>
                  <td className="mono">{formatPercent(e.percentOfPortfolio)}</td>
                  <td className="mono">{e.rotationScore == null ? "—" : e.rotationScore}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>Top Rotation Recommendations</div>
        {output.recommendations.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>None.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
            {output.recommendations.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>

      {output.flags.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>Flags</div>
          <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
            {output.flags.map((f) => (
              <li key={`${f.type}-${f.sector}`} style={{ color: "var(--negative)" }}>
                {f.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {renderSkipped(output.skipped)}
    </div>
  );
}

function renderRiskFlagList(title: string, flags: RiskFlag[], color?: string) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>{title}</div>
      {flags.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>None.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
          {flags.map((f, i) => (
            <li key={`${f.check}-${f.symbol ?? "portfolio"}-${i}`} style={{ color, marginBottom: "0.3rem" }}>
              <strong>{f.title}</strong>
              <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>{f.detail}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function renderRiskManagerReport(output: RiskManagerOutput) {
  return (
    <div className="card">
      <p style={{ color: "var(--text-muted)" }}>Total portfolio value: {formatCurrency(output.totalPortfolioValue)}</p>

      {renderRiskFlagList("Critical (act immediately)", output.critical, "var(--negative)")}
      {renderRiskFlagList("Watch (monitor closely)", output.watch)}
      {renderRiskFlagList("Informational (awareness only)", output.informational, "var(--text-muted)")}

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>401k Opportunity Cost</div>
        {output.opportunityCost.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>None.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Fund</th>
                  <th>Value</th>
                  <th>Fund 5Y</th>
                  <th>Alternative</th>
                  <th>Alt 5Y</th>
                  <th>Gap</th>
                </tr>
              </thead>
              <tbody>
                {output.opportunityCost.map((o) => (
                  <tr key={o.symbol}>
                    <td>{o.symbol}</td>
                    <td className="mono">{formatCurrency(o.currentValue)}</td>
                    <td className="mono">{formatPercent(o.fundFiveYear)}</td>
                    <td>{o.alternativeName}</td>
                    <td className="mono">{formatPercent(o.alternativeFiveYear)}</td>
                    <td className="mono" style={{ color: "var(--negative)" }}>
                      +{formatPercent(o.gap)}
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

  const initialStatuses: AgentStatusResponse = {
    relativeStrength: latestRuns[AGENT_DEFINITIONS.findIndex((d) => d.type === "RELATIVE_STRENGTH")]?.status ?? null,
    sectorRotation: latestRuns[AGENT_DEFINITIONS.findIndex((d) => d.type === "SECTOR_ROTATION")]?.status ?? null,
    riskManager: latestRuns[AGENT_DEFINITIONS.findIndex((d) => d.type === "RISK_MANAGER")]?.status ?? null,
  };

  return (
    <div>
      <AgentStatusPoller initialStatuses={initialStatuses} />
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

        let report: ReactNode;
        if (def.type === "RELATIVE_STRENGTH") {
          report = renderRelativeStrengthReport(run.output as unknown as RelativeStrengthOutput);
        } else if (def.type === "SECTOR_ROTATION") {
          report = renderSectorRotationReport(run.output as unknown as SectorRotationOutput);
        } else {
          report = renderRiskManagerReport(run.output as unknown as RiskManagerOutput);
        }

        return (
          <div key={def.type} id={`report-${def.type.toLowerCase()}`}>
            <h2>{def.name} — Full Report</h2>
            {report}
          </div>
        );
      })}
    </div>
  );
}
