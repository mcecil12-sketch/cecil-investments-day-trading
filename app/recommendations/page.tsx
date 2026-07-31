import { prisma } from "@/lib/prisma";
import { buildTaxableAnalysisContext } from "@/lib/agents/taxableAnalysis";
import type { SectorRotationOutput } from "@/lib/agents/sectorRotation";
import type { RelativeStrengthOutput } from "@/lib/agents/relativeStrength";
import type { CandidateScannerOutput, CandidateEntry } from "@/lib/agents/candidateScanner";
import type { CioTaxableOpportunities } from "@/lib/agents/cio";
import { convictionBand } from "@/lib/agents/positionSizing";
import { formatCurrency, formatPercent, formatDateTime } from "@/lib/format";
import { buildPlanFundComparisons, type PeerVerdictKind } from "@/lib/agents/planFundComparison";
import { getAccountSnapshot } from "@/lib/benchmark/portfolioValue";

export const dynamic = "force-dynamic";

function estimatedPositionSize(score: number, totalTaxableValue: number): string {
  const [lo, hi] = convictionBand(score);
  const pctLabel = `${formatPercent(lo)}–${formatPercent(hi)} of taxable portfolio`;
  if (totalTaxableValue <= 0) return pctLabel;
  return `${pctLabel} (~${formatCurrency(totalTaxableValue * lo)}–${formatCurrency(totalTaxableValue * hi)})`;
}

async function getRecommendationsData() {
  const [candidateRun, sectorRun, relativeRun, weeklyBrief, planFundComparisons, edpAccount] = await Promise.all([
    prisma.agentRun.findFirst({ where: { agentType: "CANDIDATE_SCANNER", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findFirst({ where: { agentType: "SECTOR_ROTATION", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findFirst({ where: { agentType: "RELATIVE_STRENGTH", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
    prisma.weeklyBrief.findFirst({ orderBy: { weekOf: "desc" } }),
    buildPlanFundComparisons(),
    prisma.account.findFirst({ where: { type: "VZ_EDP" } }),
  ]);

  const candidateOutput = candidateRun?.output as unknown as CandidateScannerOutput | undefined;
  const sectorOutput = sectorRun?.output as unknown as SectorRotationOutput | undefined;
  const relativeOutput = relativeRun?.output as unknown as RelativeStrengthOutput | undefined;
  const taxableOpportunities = (weeklyBrief?.taxableOpportunities as unknown as CioTaxableOpportunities | null) ?? null;

  const taxableContext = await buildTaxableAnalysisContext(sectorOutput ?? null, relativeOutput ?? null);
  const edpSnapshot = edpAccount ? await getAccountSnapshot(edpAccount.id) : null;

  return {
    candidateOutput,
    candidateRunAt: candidateRun?.completedAt ?? candidateRun?.startedAt ?? null,
    planFundComparisons,
    taxableOpportunities,
    totalTaxableValue: taxableContext?.totalTaxableValue ?? 0,
    edpBreakdown: edpSnapshot
      ? {
          totalValue: edpSnapshot.totalValue,
          lockedValue: edpSnapshot.lockedValue,
          actionableValue: edpSnapshot.actionableValue,
        }
      : null,
  };
}

const SIGNIFICANT_VS_SPX = 15;

const VERDICT_COLOR: Record<PeerVerdictKind, string | undefined> = {
  "peer-confirmed-better": "var(--negative)",
  "held-confirmed-better": "var(--positive)",
  mixed: undefined,
  "peer-short-history": undefined,
  "no-overlap": undefined,
};

function renderPlanFundComparisons(
  plans: Awaited<ReturnType<typeof buildPlanFundComparisons>>,
  edpBreakdown: { totalValue: number; lockedValue: number; actionableValue: number } | null,
) {
  const anyHeld = plans.some((p) => p.heldComparisons.length > 0);
  if (!anyHeld) {
    return (
      <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
        No held 401k funds identified in either plan&apos;s imported fund menu.
      </p>
    );
  }
  return (
    <>
      {plans.map((plan) => (
        <div key={plan.accountId} style={{ marginTop: "0.75rem" }}>
          <div className="agent-card-header" style={{ marginBottom: "0.25rem" }}>
            <span className="agent-card-name" style={{ fontSize: "0.85rem" }}>
              {plan.accountName}
            </span>
            <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>{plan.totalFunds} funds in menu</span>
          </div>
          {plan.accountType === "VZ_EDP" && edpBreakdown && (
            <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
              Locked (Verizon Stock Fund): {formatCurrency(edpBreakdown.lockedValue)} (
              {formatPercent(edpBreakdown.totalValue > 0 ? edpBreakdown.lockedValue / edpBreakdown.totalValue : 0)}) —
              single-stock concentration, monitor only, never reallocated or included in return/alpha. Flexible:{" "}
              {formatCurrency(edpBreakdown.actionableValue)} (
              {formatPercent(edpBreakdown.totalValue > 0 ? edpBreakdown.actionableValue / edpBreakdown.totalValue : 0)}
              ){plan.mirroredFrom && <> — recommendation below mirrors {plan.mirroredFrom.accountName}, not computed independently.</>}
            </p>
          )}
          {plan.heldComparisons.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
              No held funds identified in this plan&apos;s imported menu.
            </p>
          ) : (
            plan.heldComparisons.map((hc) => (
              <div className="finding-row" key={hc.fund.fundName}>
                <span className="finding-symbol">
                  {hc.fund.fundName} — YTD {formatPercent(hc.fund.ytd)} · 1Y {formatPercent(hc.fund.oneYear)} · 3Y{" "}
                  {formatPercent(hc.fund.threeYear)} · 5Y {formatPercent(hc.fund.fiveYear)} · Composite{" "}
                  {formatPercent(hc.fund.composite)}
                </span>
                <span className="finding-detail" style={{ color: hc.isBestInCategory ? "var(--positive)" : undefined }}>
                  {hc.summary}
                </span>
                {hc.fund.divergenceFlag && (
                  <span className="finding-detail" style={{ color: "var(--negative)" }}>
                    ⚠️ {hc.fund.divergenceFlag}
                  </span>
                )}
                {hc.peers.map((pc) => (
                  <span
                    className="finding-detail"
                    key={pc.peer.fundName}
                    style={{ marginTop: "0.3rem", color: VERDICT_COLOR[pc.verdictKind] }}
                  >
                    vs {pc.peer.fundName}
                    {pc.peer.isHeld ? " (also held)" : ""} — YTD {formatPercent(pc.peer.ytd)} · 1Y{" "}
                    {formatPercent(pc.peer.oneYear)} · 3Y {formatPercent(pc.peer.threeYear)} · 5Y{" "}
                    {formatPercent(pc.peer.fiveYear)} · Composite {formatPercent(pc.peer.composite)}: {pc.detail}
                    {pc.peer.divergenceFlag && <> ⚠️ {pc.peer.divergenceFlag}</>}
                  </span>
                ))}
              </div>
            ))
          )}
        </div>
      ))}
    </>
  );
}

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
  const { candidateOutput, candidateRunAt, planFundComparisons, taxableOpportunities, totalTaxableValue, edpBreakdown } =
    await getRecommendationsData();

  const taxableCandidates = (candidateOutput?.topCandidates ?? []).filter((c) => c.accountType !== "401k");

  return (
    <div>
      <h1>Recommendations</h1>
      <a href="/performance-audit" className="link-back" style={{ display: "inline-block" }}>
        View Performance Audit Trail →
      </a>

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
          Every held fund compared against genuine same-plan, same-category alternatives from the plan&apos;s complete
          imported fund menu, across YTD/1Y/3Y/5Y plus a blended Composite (20% YTD / 30% 1Y / 30% 3Y / 20% 5Y) — not
          a single cherry-picked horizon. Funds recently added to a plan&apos;s menu are flagged as such rather than
          implied to be unproven. A fund whose YTD and 1Y returns point in opposite directions and diverge sharply is
          flagged for a closer look before acting on either figure.
        </p>
        {renderPlanFundComparisons(planFundComparisons, edpBreakdown)}
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
