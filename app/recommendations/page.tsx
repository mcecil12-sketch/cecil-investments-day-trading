import { prisma } from "@/lib/prisma";
import { getCurrentHoldings } from "@/lib/agents/holdings";
import { buildTaxableAnalysisContext } from "@/lib/agents/taxableAnalysis";
import type { SectorRotationOutput } from "@/lib/agents/sectorRotation";
import type { RelativeStrengthOutput } from "@/lib/agents/relativeStrength";
import type { RiskManagerOutput, OpportunityCostEntry } from "@/lib/agents/riskManager";
import type { CandidateScannerOutput, CandidateEntry } from "@/lib/agents/candidateScanner";
import type { CioTaxableOpportunities } from "@/lib/agents/cio";
import { formatCurrency, formatPercent, formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Score bands driving the "estimated position size" heuristic on the Taxable card — higher conviction gets a larger suggested slice of the taxable portfolio. */
function convictionBand(score: number): [number, number] {
  if (score >= 90) return [0.04, 0.06];
  if (score >= 80) return [0.02, 0.04];
  return [0.01, 0.02];
}

function estimatedPositionSize(score: number, totalTaxableValue: number): string {
  const [lo, hi] = convictionBand(score);
  const pctLabel = `${formatPercent(lo)}–${formatPercent(hi)} of taxable portfolio`;
  if (totalTaxableValue <= 0) return pctLabel;
  return `${pctLabel} (~${formatCurrency(totalTaxableValue * lo)}–${formatCurrency(totalTaxableValue * hi)})`;
}

async function getRecommendationsData() {
  const [candidateRun, riskRun, sectorRun, relativeRun, weeklyBrief, accounts, holdings] = await Promise.all([
    prisma.agentRun.findFirst({ where: { agentType: "CANDIDATE_SCANNER", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findFirst({ where: { agentType: "RISK_MANAGER", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findFirst({ where: { agentType: "SECTOR_ROTATION", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findFirst({ where: { agentType: "RELATIVE_STRENGTH", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
    prisma.weeklyBrief.findFirst({ orderBy: { weekOf: "desc" } }),
    prisma.account.findMany(),
    getCurrentHoldings(),
  ]);

  const candidateOutput = candidateRun?.output as unknown as CandidateScannerOutput | undefined;
  const riskOutput = riskRun?.output as unknown as RiskManagerOutput | undefined;
  const sectorOutput = sectorRun?.output as unknown as SectorRotationOutput | undefined;
  const relativeOutput = relativeRun?.output as unknown as RelativeStrengthOutput | undefined;
  const taxableOpportunities = (weeklyBrief?.taxableOpportunities as unknown as CioTaxableOpportunities | null) ?? null;

  const taxableContext = await buildTaxableAnalysisContext(sectorOutput ?? null, relativeOutput ?? null);

  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));
  const planFundRows = (riskOutput?.opportunityCost ?? []).map((entry: OpportunityCostEntry) => {
    const holding = holdings.find((h) => h.symbol === entry.symbol);
    const accountNames = holding
      ? [...new Set(holding.accounts.map((a) => accountNameById.get(a.accountId) ?? a.accountId))]
      : [];
    return {
      symbol: entry.symbol,
      currentFund: entry.name ?? entry.symbol,
      recommendedFund: entry.alternativeName,
      performanceGap: entry.gap,
      accounts: accountNames,
    };
  });

  return {
    candidateOutput,
    candidateRunAt: candidateRun?.completedAt ?? candidateRun?.startedAt ?? null,
    planFundRows,
    taxableOpportunities,
    totalTaxableValue: taxableContext?.totalTaxableValue ?? 0,
  };
}

const SIGNIFICANT_VS_SPX = 15;

function renderTopCandidates(candidates: CandidateEntry[]) {
  if (candidates.length === 0) {
    return <p style={{ color: "var(--text-muted)" }}>No candidates scored above the S&amp;P 500 baseline this run.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Sector</th>
            <th>Score</th>
            <th>vs S&amp;P</th>
            <th>Momentum</th>
            <th>Account</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => (
            <tr key={c.symbol}>
              <td>
                <details>
                  <summary style={{ cursor: "pointer", fontWeight: 600 }}>{c.symbol}</summary>
                  <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginTop: "0.3rem", maxWidth: "22rem" }}>
                    {c.rationale}
                  </div>
                </details>
              </td>
              <td>{c.sector}</td>
              <td className="mono" style={{ color: c.vsSpx >= SIGNIFICANT_VS_SPX ? "var(--positive)" : undefined }}>
                {c.score}
              </td>
              <td className="mono" style={{ color: c.vsSpx >= SIGNIFICANT_VS_SPX ? "var(--positive)" : undefined }}>
                +{c.vsSpx}
              </td>
              <td className="mono">{formatPercent(c.momentum1Y)}</td>
              <td className="mono" style={{ color: "var(--text-muted)" }}>{c.accountType}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function RecommendationsPage() {
  const { candidateOutput, candidateRunAt, planFundRows, taxableOpportunities, totalTaxableValue } =
    await getRecommendationsData();

  const taxableCandidates = (candidateOutput?.topCandidates ?? []).filter((c) => c.accountType !== "401k");

  return (
    <div>
      <h1>Recommendations</h1>

      {!candidateOutput && (
        <div className="card">
          <p style={{ color: "var(--text-muted)" }}>
            No Candidate Scanner run yet — this fills in automatically after the next Risk Manager run, or trigger it
            manually from the Agents page.
          </p>
        </div>
      )}

      <div className="card card-accent">
        <div className="agent-card-header">
          <strong>Highest Conviction Opportunities</strong>
          {candidateRunAt && (
            <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>As of {formatDateTime(candidateRunAt)}</span>
          )}
        </div>
        {renderTopCandidates(candidateOutput?.topCandidates ?? [])}
      </div>

      {candidateOutput && candidateOutput.sectorAlignment.length > 0 && (
        <div className="card">
          <strong>Sector Alignment</strong>
          <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: "0.25rem" }}>
            Current portfolio exposure vs. the leading sectors from this week&apos;s Sector Rotation ranking.
          </p>
          <div className="table-wrap" style={{ marginTop: "0.5rem" }}>
            <table>
              <thead>
                <tr>
                  <th>Sector</th>
                  <th>Rank</th>
                  <th>Current Exposure</th>
                  <th>Recommended</th>
                  <th>Close the Gap With</th>
                </tr>
              </thead>
              <tbody>
                {candidateOutput.sectorAlignment.map((s) => (
                  <tr key={s.sector}>
                    <td>{s.sector}</td>
                    <td className="mono">#{s.rotationRank}</td>
                    <td className="mono">{formatPercent(s.currentExposure)}</td>
                    <td style={{ fontSize: "0.85rem" }}>{s.recommendedExposure}</td>
                    <td className="mono">{s.topCandidate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <strong>401k Specific Recommendations</strong>
        <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: "0.25rem" }}>
          Actionable swaps within each plan&apos;s fixed fund menu — a current fund with a better-returning peer already
          available in the same Verizon plan.
        </p>
        {planFundRows.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>No actionable 401k swaps flagged this week.</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: "0.5rem" }}>
            <table>
              <thead>
                <tr>
                  <th>Current Fund</th>
                  <th>Recommended Fund</th>
                  <th>Performance Gap (5Y)</th>
                  <th>Account</th>
                </tr>
              </thead>
              <tbody>
                {planFundRows.map((row) => (
                  <tr key={row.symbol}>
                    <td>{row.currentFund}</td>
                    <td>{row.recommendedFund}</td>
                    <td className="mono" style={{ color: "var(--negative)" }}>
                      +{formatPercent(row.performanceGap)}
                    </td>
                    <td style={{ fontSize: "0.85rem" }}>{row.accounts.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <strong>Taxable Account Recommendations</strong>
        <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: "0.25rem" }}>
          Stocks and ETFs to consider adding with new taxable capital, sized by conviction score.
        </p>
        {taxableCandidates.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>No taxable-eligible candidates this week.</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: "0.5rem" }}>
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Sector</th>
                  <th>Score</th>
                  <th>Estimated Position Size</th>
                </tr>
              </thead>
              <tbody>
                {taxableCandidates.map((c) => (
                  <tr key={c.symbol}>
                    <td>{c.symbol}</td>
                    <td>{c.sector}</td>
                    <td className="mono">{c.score}</td>
                    <td style={{ fontSize: "0.85rem" }}>{estimatedPositionSize(c.score, totalTaxableValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="agent-card-header" style={{ marginTop: "1rem" }}>
          <span className="agent-card-name" style={{ fontSize: "0.85rem" }}>Trim First — Embedded Gain</span>
        </div>
        {!taxableOpportunities || taxableOpportunities.trimCandidates.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
            No existing position flagged for trimming ahead of a new buy.
          </p>
        ) : (
          taxableOpportunities.trimCandidates.map((t, i) => (
            <div className="finding-row" key={`trim-${i}`}>
              <span className="finding-symbol">
                {t.symbol} — est. embedded gain {t.estimatedGain}
              </span>
              <span className="finding-detail">
                {t.rationale} {t.taxImpact}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
