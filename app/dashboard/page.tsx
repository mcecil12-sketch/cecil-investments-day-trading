import { prisma } from "@/lib/prisma";
import { computeBenchmark, FIDELITY_PERIODS } from "@/lib/benchmark/engine";
import type { AccountBenchmarkResult, BenchmarkComputation, FidelityPeriodKey } from "@/lib/benchmark/engine";
import { alphaColor, formatCompactCurrency, formatCurrency, formatPercent } from "@/lib/format";

export const dynamic = "force-dynamic";

const DASHBOARD_PERIODS: FidelityPeriodKey[] = ["ytd", "1y"];
const PERIOD_LABELS: Record<FidelityPeriodKey, string> = {
  ytd: "YTD",
  "1y": "1Y",
  "3y": "3Y",
};

export default async function DashboardPage() {
  let computation: BenchmarkComputation | null = null;
  let computeError: string | null = null;
  try {
    computation = await computeBenchmark();
  } catch (err) {
    computeError = err instanceof Error ? err.message : String(err);
  }

  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });

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
        {DASHBOARD_PERIODS.map((period) => {
          const result = totalPortfolio.find((r) => r.period === period) ?? null;
          return (
            <div className="card" key={period}>
              <div className="period-card-label">{PERIOD_LABELS[period]}</div>
              <div className="period-card-row">
                <span>Portfolio</span>
                <span className="value">{formatPercent(result?.portfolioReturn ?? null)}</span>
              </div>
              <div className="period-card-row">
                <span>S&amp;P 500</span>
                <span className="value">{formatPercent(result?.sp500Return ?? null)}</span>
              </div>
              <div className="period-card-alpha" style={{ color: alphaColor(result?.alpha ?? null) }}>
                {formatPercent(result?.alpha ?? null)}
              </div>
            </div>
          );
        })}
        <div className="card">
          <div className="period-card-label">Since Purchase</div>
          <div className="period-card-row">
            <span>Portfolio</span>
            <span className="value">{formatPercent(sincePurchase?.portfolioReturn ?? null)}</span>
          </div>
          <div className="period-card-row">
            <span>S&amp;P 500</span>
            <span className="value">{formatPercent(sincePurchase?.sp500Return ?? null)}</span>
          </div>
          <div className="period-card-alpha" style={{ color: alphaColor(sincePurchase?.alpha ?? null) }}>
            {formatPercent(sincePurchase?.alpha ?? null)}
          </div>
        </div>
      </div>

      <h2>Accounts</h2>
      <div className="card">
        {accounts.map((account) => {
          const value = accountValueByAccount.get(account.id) ?? null;
          const split = accountSplitByAccount.get(account.id) ?? null;
          const results = accountResultsByAccount.get(account.id) ?? [];
          return (
            <div className={`account-row${account.isLocked ? " muted" : ""}`} key={account.id}>
              <div className="account-main">
                <div className="account-info">
                  <div className="account-name">{account.name}</div>
                  <div className="account-meta">
                    <span>{account.type}</span>
                    {account.isLocked && <span className="badge">Monitor Only</span>}
                  </div>
                </div>
                <div className="account-figures">
                  <div className="account-value">{formatCurrency(value)}</div>
                  {!account.isLocked &&
                    DASHBOARD_PERIODS.map((period) => {
                      const result = results.find((r) => r.period === period);
                      return (
                        <div key={period} className="account-alpha" style={{ color: alphaColor(result?.alpha ?? null) }}>
                          {formatPercent(result?.alpha ?? null)} {PERIOD_LABELS[period]}
                        </div>
                      );
                    })}
                </div>
              </div>
              {split && (
                <div className="account-split">
                  ({formatCompactCurrency(split.locked)} locked / {formatCompactCurrency(split.actionable)}{" "}
                  actionable)
                </div>
              )}
            </div>
          );
        })}
        {accounts.length === 0 && (
          <p style={{ color: "var(--text-muted)" }}>No accounts yet — add one and import a statement first.</p>
        )}
      </div>
    </div>
  );
}
