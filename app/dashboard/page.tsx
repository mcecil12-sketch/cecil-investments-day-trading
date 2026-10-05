import { prisma } from "@/lib/prisma";
import { computeBenchmark, FIDELITY_PERIODS } from "@/lib/benchmark/engine";
import type {
  AccountBenchmarkResult,
  AccountSincePurchaseResult,
  BenchmarkComputation,
  FidelityPeriodKey,
} from "@/lib/benchmark/engine";
import {
  alphaColor,
  formatCompactCurrency,
  formatCurrency,
  formatPercent,
  formatSignedCurrency,
} from "@/lib/format";
import { getRecommendationPerformance } from "@/lib/agents/recommendationPerformance";
import type { TimeframeKey } from "@/lib/timeframes";
import { RecommendationPerformanceCharts, type PickQualityChartPoint } from "./RecommendationPerformanceCharts";

export const dynamic = "force-dynamic";

const DASHBOARD_PERIODS: FidelityPeriodKey[] = ["ytd", "1y"];
const PERIOD_LABELS: Record<FidelityPeriodKey, string> = {
  ytd: "YTD",
  "1y": "1Y",
  "3y": "3Y",
};

interface PeriodCardData {
  key: string;
  label: string;
  portfolioReturn: number | null;
  sp500Return: number | null;
  alpha: number | null;
  /** Dollar gain shown on the Portfolio row — an estimate (return % × current value) for YTD/1Y, exact (current value − cost basis) for Since Purchase. */
  portfolioGain: number | null;
  portfolioGainEstimated: boolean;
  /** Wording for the S&P row and alpha row — Since Purchase says "price" because its S&P side is price-only while YTD/1Y use a total-return benchmark. */
  sp500Label: string;
  alphaLabel: string;
  /** Equivalent dollar gain shown on the S&P row, had the same starting balance earned the S&P's return instead. */
  sp500Gain: number | null;
}

/** One period's figures for a single account in the accounts table — mirrors a portfolio benchmark card's metrics. */
function PeriodCell({
  portfolioReturn,
  gain,
  gainEstimated,
  alpha,
  sourceLabel,
  alphaLabel = "α vs S&P",
}: {
  portfolioReturn: number | null;
  gain: number | null;
  gainEstimated: boolean;
  alpha: number | null;
  sourceLabel: string | null;
  /** Benchmark wording after the alpha figure — Since Purchase overrides it since its S&P side is price-only, unlike the total-return benchmark behind YTD/1Y. */
  alphaLabel?: string;
}) {
  return (
    <>
      <div className="account-perf-return">{formatPercent(portfolioReturn)}</div>
      <div className="account-perf-gain" style={{ color: alphaColor(gain) }}>
        {formatSignedCurrency(gain)}
        {gainEstimated && gain != null ? " est." : ""}
      </div>
      <div className="account-perf-alpha" style={{ color: alphaColor(alpha) }}>
        {formatPercent(alpha)} {alphaLabel}
      </div>
      {sourceLabel && <div className="account-perf-source">{sourceLabel}</div>}
    </>
  );
}

export default async function DashboardPage() {
  let computation: BenchmarkComputation | null = null;
  let computeError: string | null = null;
  try {
    computation = await computeBenchmark();
  } catch (err) {
    computeError = err instanceof Error ? err.message : String(err);
  }

  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });

  let recPerformance: Awaited<ReturnType<typeof getRecommendationPerformance>> | null = null;
  try {
    recPerformance = await getRecommendationPerformance(computation?.totalCurrentValue);
  } catch (err) {
    console.error("getRecommendationPerformance failed:", err);
  }

  if (computeError || !computation) {
    return (
      <div>
        <h1>Dashboard</h1>
        <div className="card">
          <p style={{ color: "var(--negative)" }}>
            Couldn&apos;t compute benchmark data: {computeError}
          </p>
        </div>
      </div>
    );
  }

  const totalPortfolio = computation.aggregate.filter((r) => r.scope === "AGGREGATE_TOTAL");
  const ytdAlpha = totalPortfolio.find((r) => r.period === "ytd") ?? null;
  const oneYearAlpha = totalPortfolio.find((r) => r.period === "1y") ?? null;

  const accountResultsByAccount = new Map<string, AccountBenchmarkResult[]>();
  for (const result of computation.accounts) {
    const list = accountResultsByAccount.get(result.accountId) ?? [];
    list.push(result);
    accountResultsByAccount.set(result.accountId, list);
  }

  const accountValueByAccount = new Map<string, number>();
  const accountSplitByAccount = new Map<string, { locked: number; actionable: number }>();
  for (const result of computation.accounts) {
    if (result.period !== FIDELITY_PERIODS[0]) continue;
    accountValueByAccount.set(result.accountId, result.endValue);
    if (result.currentLockedValue > 0) {
      accountSplitByAccount.set(result.accountId, {
        locked: result.currentLockedValue,
        actionable: result.currentActionableValue,
      });
    }
  }

  const sincePurchase = computation.aggregateSincePurchase;

  const sincePurchaseByAccount = new Map<string, AccountSincePurchaseResult>();
  for (const result of computation.sincePurchase) {
    sincePurchaseByAccount.set(result.accountId, result);
  }

  const periodCards: PeriodCardData[] = DASHBOARD_PERIODS.map((period) => {
    const result = totalPortfolio.find((r) => r.period === period) ?? null;
    const portfolioReturn = result?.portfolioReturn ?? null;
    const sp500Return = result?.sp500Return ?? null;
    return {
      key: period,
      label: PERIOD_LABELS[period],
      portfolioReturn,
      sp500Return,
      alpha: result?.alpha ?? null,
      portfolioGain: portfolioReturn != null ? computation.totalCurrentValue * portfolioReturn : null,
      portfolioGainEstimated: true,
      sp500Label: "S&P 500 (benchmark)",
      alphaLabel: "Alpha vs. S&P 500",
      sp500Gain: sp500Return != null ? computation.totalCurrentValue * sp500Return : null,
    };
  });
  periodCards.push({
    key: "since-purchase",
    label: "Since Purchase",
    portfolioReturn: sincePurchase?.portfolioReturn ?? null,
    sp500Return: sincePurchase?.sp500Return ?? null,
    alpha: sincePurchase?.alpha ?? null,
    portfolioGain: sincePurchase ? sincePurchase.currentValue - sincePurchase.costBasis : null,
    portfolioGainEstimated: false,
    sp500Label: "S&P 500 (price only)",
    alphaLabel: "Alpha vs. S&P 500 price return",
    sp500Gain:
      sincePurchase?.sp500Return != null ? sincePurchase.costBasis * sincePurchase.sp500Return : null,
  });

  return (
    <div>
      <div className="top-bar">
        <div>
          <div className="top-bar-label">YTD Alpha vs S&amp;P (Total Portfolio)</div>
          <div className="top-bar-alpha" style={{ color: alphaColor(ytdAlpha?.alpha ?? null) }}>
            {formatPercent(ytdAlpha?.alpha ?? null)}
          </div>
        </div>
        <div>
          <div className="top-bar-label">1Y Alpha vs S&amp;P (Total Portfolio)</div>
          <div className="top-bar-alpha" style={{ color: alphaColor(oneYearAlpha?.alpha ?? null) }}>
            {formatPercent(oneYearAlpha?.alpha ?? null)}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="total-value-label">Total Portfolio Value</div>
        <div className="total-value">{formatCurrency(computation.totalCurrentValue)}</div>
      </div>

      <div className="period-cards">
        {periodCards.map((card) => (
          <div className="card" key={card.key}>
            <div className="period-card-label">{card.label}</div>
            <div className="period-card-row">
              <span>Portfolio</span>
              <span className="value">
                {formatPercent(card.portfolioReturn)}
                <span className="period-card-gain" style={{ color: alphaColor(card.portfolioGain) }}>
                  {formatSignedCurrency(card.portfolioGain)}
                  {card.portfolioGainEstimated && card.portfolioGain != null ? " est." : ""}
                </span>
              </span>
            </div>
            <div className="period-card-row">
              <span>{card.sp500Label}</span>
              <span className="value">
                {formatPercent(card.sp500Return)}
                <span className="period-card-gain" style={{ color: alphaColor(card.sp500Gain) }}>
                  {formatSignedCurrency(card.sp500Gain)}
                </span>
              </span>
            </div>
            <div
              className={`period-card-alpha${card.alpha != null ? (card.alpha >= 0 ? " tint-positive" : " tint-negative") : ""}`}
            >
              <div className="period-card-alpha-label">{card.alphaLabel}</div>
              <div className="period-card-alpha-value" style={{ color: alphaColor(card.alpha) }}>
                {formatPercent(card.alpha)}
              </div>
            </div>
          </div>
        ))}
      </div>

      <h2>Accounts</h2>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Value</th>
                <th>YTD</th>
                <th>1Y</th>
                <th>Since Purchase</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const value = accountValueByAccount.get(account.id) ?? null;
                const split = accountSplitByAccount.get(account.id) ?? null;
                const results = accountResultsByAccount.get(account.id) ?? [];
                const ytd = results.find((r) => r.period === "ytd");
                const oneYear = results.find((r) => r.period === "1y");
                const purchase = sincePurchaseByAccount.get(account.id);

                return (
                  <tr key={account.id} className={account.isLocked ? "muted" : undefined}>
                    <td>
                      <div className="account-perf-name">{account.name}</div>
                      <div className="account-meta">
                        <span>{account.type}</span>
                        {account.isLocked && <span className="badge">Monitor Only</span>}
                      </div>
                      {split && (
                        <div className="account-perf-source">
                          {formatCompactCurrency(split.locked)} locked / {formatCompactCurrency(split.actionable)}{" "}
                          actionable
                        </div>
                      )}
                    </td>
                    <td className="mono">{formatCurrency(value)}</td>
                    {account.type === "VZ_LTI" ? (
                      // Locked/Monitor Only like before, but the stock's own YTD/1Y
                      // total return vs the S&P 500 is shown — no dollar gain, since
                      // that would depend on a share count this method ignores.
                      <>
                        {[ytd, oneYear].map((result, i) => (
                          <td className="account-perf-cell" key={i === 0 ? "ytd" : "1y"}>
                            <PeriodCell
                              portfolioReturn={result?.portfolioReturn ?? null}
                              gain={null}
                              gainEstimated={false}
                              alpha={result?.alpha ?? null}
                              sourceLabel="Computed: VZ total return vs S&P 500 TR"
                            />
                          </td>
                        ))}
                        <td style={{ color: "var(--text-muted)" }}>Excluded — no purchase basis</td>
                      </>
                    ) : account.isLocked && ytd?.portfolioReturn == null && oneYear?.portfolioReturn == null ? (
                      // Only when a locked account has no reported YTD/1Y at all — if
                      // data exists (e.g. an imported Performance PDF for Verizon EDP),
                      // it renders like any other account. The engine always emits a
                      // row per period, so the gate checks the values, not the rows.
                      <td colSpan={3} style={{ color: "var(--text-muted)" }}>
                        Monitor Only — excluded from alpha
                      </td>
                    ) : (
                      <>
                        <td className="account-perf-cell">
                          <PeriodCell
                            portfolioReturn={ytd?.portfolioReturn ?? null}
                            gain={
                              ytd?.portfolioReturn != null && value != null ? value * ytd.portfolioReturn : null
                            }
                            gainEstimated
                            alpha={ytd?.alpha ?? null}
                            sourceLabel={ytd?.asOfDate ? "via Fidelity Performance PDF" : "Not yet reported"}
                          />
                        </td>
                        <td className="account-perf-cell">
                          <PeriodCell
                            portfolioReturn={oneYear?.portfolioReturn ?? null}
                            gain={
                              oneYear?.portfolioReturn != null && value != null
                                ? value * oneYear.portfolioReturn
                                : null
                            }
                            gainEstimated
                            alpha={oneYear?.alpha ?? null}
                            sourceLabel={oneYear?.asOfDate ? "via Fidelity Performance PDF" : "Not yet reported"}
                          />
                        </td>
                        <td className="account-perf-cell">
                          <PeriodCell
                            portfolioReturn={purchase?.portfolioReturn ?? null}
                            gain={purchase ? purchase.currentValue - purchase.costBasis : null}
                            gainEstimated={false}
                            alpha={purchase?.alpha ?? null}
                            sourceLabel={null}
                            alphaLabel="α vs S&P (price only)"
                          />
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {accounts.length === 0 && (
          <p style={{ color: "var(--text-muted)" }}>No accounts yet — add one and import a statement first.</p>
        )}
      </div>

      {recPerformance && (
        <RecommendationPerformanceCharts
          pickQualityByTimeframe={
            Object.fromEntries(
              Object.entries(recPerformance.pickQualityByTimeframe).map(([key, points]) => [
                key,
                points.map((p) => ({
                  date: p.date.toISOString().slice(0, 10),
                  pickReturn: p.pickReturn,
                  spxReturn: p.spxReturn,
                  activeCount: p.activeCount,
                })),
              ]),
            ) as Record<TimeframeKey, PickQualityChartPoint[]>
          }
          simulatedPortfolio={recPerformance.simulatedPortfolio.map((p) => ({
            date: p.date.toISOString().slice(0, 10),
            portfolioValue: p.portfolioValue,
            pnl: p.pnl,
            pnlPct: p.pnlPct,
            activeCount: p.activeCount,
          }))}
          baseValue={recPerformance.baseValue}
          trackedSince={recPerformance.trackedSince ? recPerformance.trackedSince.toISOString() : null}
          totalPositions={recPerformance.totalPositions}
          trackingNote="Each position starts from its entry date forward — a single missed week doesn't close it, but 2 consecutive missed weeks do, and re-entry after a close starts a fresh position."
        />
      )}
    </div>
  );
}
