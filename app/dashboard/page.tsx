import { prisma } from "@/lib/prisma";
import { computeBenchmark } from "@/lib/benchmark/engine";
import type { BenchmarkComputation } from "@/lib/benchmark/engine";
import { persistBenchmarkResults } from "@/lib/benchmark/persist";
import { BENCHMARK_PERIODS, type BenchmarkPeriodKey } from "@/lib/benchmark/math";
import { alphaColor, formatCompactCurrency, formatCurrency, formatPercent } from "@/lib/format";

export const dynamic = "force-dynamic";

const PERIOD_LABELS: Record<BenchmarkPeriodKey, string> = {
  "1y": "1Y",
  "3y": "3Y",
  "5y": "5Y",
};

export default async function DashboardPage() {
  let computation: BenchmarkComputation | null = null;
  let computeError: string | null = null;
  try {
    computation = await computeBenchmark();
    await persistBenchmarkResults(computation);
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

  const actionable = computation.aggregate.filter((r) => r.scope === "AGGREGATE_ACTIONABLE");
  const headlineAlpha = actionable.find((r) => r.period === "1y") ?? null;

  const accountAlphaByAccount = new Map<string, number | null>();
  const accountValueByAccount = new Map<string, number>();
  const accountSplitByAccount = new Map<string, { locked: number; actionable: number }>();
  for (const result of computation.accounts) {
    if (result.period !== "1y") continue;
    accountAlphaByAccount.set(result.accountId, result.alpha);
    accountValueByAccount.set(result.accountId, result.endValue);
    if (result.currentLockedValue > 0) {
      accountSplitByAccount.set(result.accountId, {
        locked: result.currentLockedValue,
        actionable: result.currentActionableValue,
      });
    }
  }

  return (
    <div>
      <div className="top-bar">
        <div>
          <div className="top-bar-label">1Y Alpha vs S&amp;P (Actionable)</div>
          <div className="top-bar-alpha" style={{ color: alphaColor(headlineAlpha?.alpha ?? null) }}>
            {formatPercent(headlineAlpha?.alpha ?? null)}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="total-value-label">Total Portfolio Value</div>
        <div className="total-value">{formatCurrency(computation.totalCurrentValue)}</div>
      </div>

      <div className="period-cards">
        {BENCHMARK_PERIODS.map(({ key }) => {
          const result = actionable.find((r) => r.period === key) ?? null;
          return (
            <div className="card" key={key}>
              <div className="period-card-label">{PERIOD_LABELS[key]}</div>
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
      </div>

      <h2>Accounts</h2>
      <div className="card">
        {accounts.map((account) => {
          const value = accountValueByAccount.get(account.id) ?? null;
          const alpha = accountAlphaByAccount.get(account.id) ?? null;
          const split = accountSplitByAccount.get(account.id) ?? null;
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
                  {!account.isLocked && (
                    <div className="account-alpha" style={{ color: alphaColor(alpha) }}>
                      {formatPercent(alpha)} 1Y
                    </div>
                  )}
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
