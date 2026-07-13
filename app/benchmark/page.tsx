import { prisma } from "@/lib/prisma";
import { computeBenchmark } from "@/lib/benchmark/engine";
import type {
  AccountBenchmarkResult,
  AccountSincePurchaseResult,
  AggregateBenchmarkResult,
  BenchmarkComputation,
} from "@/lib/benchmark/engine";
import { persistBenchmarkResults } from "@/lib/benchmark/persist";
import { BENCHMARK_PERIODS, type BenchmarkPeriodKey } from "@/lib/benchmark/math";
import { alphaColor, formatCurrency, formatDate, formatPercent } from "@/lib/format";

export const dynamic = "force-dynamic";

const PERIOD_LABELS: Record<BenchmarkPeriodKey, string> = {
  "1y": "1 Year",
  "3y": "3 Year",
  "5y": "5 Year",
};

const AGGREGATE_SCOPES = ["AGGREGATE_TOTAL", "AGGREGATE_ACTIONABLE"] as const;
const SCOPE_LABELS: Record<(typeof AGGREGATE_SCOPES)[number], string> = {
  AGGREGATE_TOTAL: "All Accounts",
  AGGREGATE_ACTIONABLE: "Actionable (Unlocked)",
};

export default async function BenchmarkPage() {
  let computation: BenchmarkComputation | null = null;
  let computeError: string | null = null;
  try {
    computation = await computeBenchmark();
    await persistBenchmarkResults(computation);
  } catch (err) {
    computeError = err instanceof Error ? err.message : String(err);
  }

  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });

  if (computeError) {
    return (
      <div>
        <h1>Benchmark</h1>
        <div className="card">
          <p style={{ color: "var(--negative)" }}>Couldn&apos;t compute benchmark data: {computeError}</p>
        </div>
      </div>
    );
  }

  const accountResultsByAccount = new Map<string, AccountBenchmarkResult[]>();
  for (const result of computation!.accounts) {
    const list = accountResultsByAccount.get(result.accountId) ?? [];
    list.push(result);
    accountResultsByAccount.set(result.accountId, list);
  }

  const aggregateByScope = new Map<string, AggregateBenchmarkResult[]>();
  for (const result of computation!.aggregate) {
    const list = aggregateByScope.get(result.scope) ?? [];
    list.push(result);
    aggregateByScope.set(result.scope, list);
  }

  const sincePurchaseByAccount = new Map<string, AccountSincePurchaseResult>();
  for (const result of computation!.sincePurchase) {
    sincePurchaseByAccount.set(result.accountId, result);
  }

  return (
    <div>
      <h1>Benchmark</h1>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Total current value</div>
            <div className="mono" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
              {formatCurrency(computation!.totalCurrentValue)}
            </div>
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", alignSelf: "flex-end" }}>
            Computed {formatDate(computation!.computedAt)}
          </div>
        </div>
      </div>

      <h2>Portfolio vs. S&amp;P 500</h2>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Scope</th>
                <th>Period</th>
                <th>Portfolio Return</th>
                <th>S&amp;P 500 Return</th>
                <th>Alpha</th>
                <th>Value (start → end)</th>
              </tr>
            </thead>
            <tbody>
              {AGGREGATE_SCOPES.flatMap((scope) => {
                const results = aggregateByScope.get(scope) ?? [];
                return BENCHMARK_PERIODS.map(({ key }) => {
                  const result = results.find((r) => r.period === key);
                  return (
                    <tr key={`${scope}-${key}`}>
                      <td>{SCOPE_LABELS[scope]}</td>
                      <td>{PERIOD_LABELS[key]}</td>
                      <td className="mono">{formatPercent(result?.portfolioReturn ?? null)}</td>
                      <td className="mono">{formatPercent(result?.sp500Return ?? null)}</td>
                      <td className="mono" style={{ color: alphaColor(result?.alpha ?? null) }}>
                        {formatPercent(result?.alpha ?? null)}
                      </td>
                      <td className="mono" style={{ color: "var(--text-muted)" }}>
                        {result
                          ? `${formatCurrency(result.startValue)} → ${formatCurrency(result.endValue)}`
                          : "No data"}
                        {result?.insufficientHistory && " (partial window)"}
                        {result && result.excludedAccountIds.length > 0
                          ? ` — excludes ${result.excludedAccountIds.length} account(s) without history`
                          : ""}
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      </div>

      <h2>By Account</h2>
      {accounts.map((account) => {
        const results = accountResultsByAccount.get(account.id) ?? [];
        const sincePurchase = sincePurchaseByAccount.get(account.id);
        return (
          <div className="card" key={account.id}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
              <strong>{account.name}</strong>
              <span style={{ color: "var(--text-muted)" }}>
                {account.type}
                {account.isLocked ? " · Locked" : ""}
              </span>
            </div>
            {results.length === 0 ? (
              <p style={{ color: "var(--text-muted)" }}>
                No snapshot data yet — import a statement to see benchmark data.
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Portfolio Return</th>
                      <th>S&amp;P 500 Return</th>
                      <th>Alpha</th>
                      <th>Value (start → end)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {BENCHMARK_PERIODS.map(({ key }) => {
                      const result = results.find((r) => r.period === key);
                      return (
                        <tr key={key}>
                          <td>{PERIOD_LABELS[key]}</td>
                          <td className="mono">{formatPercent(result?.portfolioReturn ?? null)}</td>
                          <td className="mono">{formatPercent(result?.sp500Return ?? null)}</td>
                          <td className="mono" style={{ color: alphaColor(result?.alpha ?? null) }}>
                            {formatPercent(result?.alpha ?? null)}
                          </td>
                          <td className="mono" style={{ color: "var(--text-muted)" }}>
                            {result
                              ? `${formatCurrency(result.startValue)} → ${formatCurrency(result.endValue)}`
                              : "—"}
                            {result?.insufficientHistory && " (partial window)"}
                          </td>
                        </tr>
                      );
                    })}
                    {sincePurchase && (
                      <tr>
                        <td>Since Purchase (est.)</td>
                        <td className="mono">{formatPercent(sincePurchase.portfolioReturn)}</td>
                        <td className="mono">{formatPercent(sincePurchase.sp500Return)}</td>
                        <td className="mono" style={{ color: alphaColor(sincePurchase.alpha) }}>
                          {formatPercent(sincePurchase.alpha)}
                        </td>
                        <td className="mono" style={{ color: "var(--text-muted)" }}>
                          {formatCurrency(sincePurchase.costBasis)} → {formatCurrency(sincePurchase.currentValue)}
                          {" (cost basis vs. current value — no purchase date on record, S&P 500 side estimated from "}
                          {formatDate(sincePurchase.estimatedHoldingStart)}
                          {")"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {accounts.length === 0 && (
        <p style={{ color: "var(--text-muted)" }}>No accounts yet — add one and import a statement first.</p>
      )}
    </div>
  );
}
