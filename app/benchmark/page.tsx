import { prisma } from "@/lib/prisma";
import { computeBenchmark, FIDELITY_PERIODS } from "@/lib/benchmark/engine";
import type {
  AccountBenchmarkResult,
  AccountSincePurchaseResult,
  AggregateBenchmarkResult,
  BenchmarkComputation,
  FidelityPeriodKey,
} from "@/lib/benchmark/engine";
import { alphaColor, formatCurrency, formatDate, formatPercent } from "@/lib/format";

export const dynamic = "force-dynamic";

const PERIOD_LABELS: Record<FidelityPeriodKey, string> = {
  ytd: "YTD",
  "1y": "1 Year",
  "3y": "3 Year",
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
  } catch (err) {
    computeError = err instanceof Error ? err.message : String(err);
  }

  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });

  if (computeError || !computation) {
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
  for (const result of computation.accounts) {
    const list = accountResultsByAccount.get(result.accountId) ?? [];
    list.push(result);
    accountResultsByAccount.set(result.accountId, list);
  }

  const aggregateByScope = new Map<string, AggregateBenchmarkResult[]>();
  for (const result of computation.aggregate) {
    const list = aggregateByScope.get(result.scope) ?? [];
    list.push(result);
    aggregateByScope.set(result.scope, list);
  }

  const sincePurchaseByAccount = new Map<string, AccountSincePurchaseResult>();
  for (const result of computation.sincePurchase) {
    sincePurchaseByAccount.set(result.accountId, result);
  }

  const aggregateSincePurchase = computation.aggregateSincePurchase;

  return (
    <div>
      <h1>Benchmark</h1>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Total current value</div>
            <div className="mono" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
              {formatCurrency(computation.totalCurrentValue)}
            </div>
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", alignSelf: "flex-end" }}>
            Computed {formatDate(computation.computedAt)}
          </div>
        </div>
      </div>

      <h2>Portfolio vs. S&amp;P 500</h2>
      <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
        Rolling period returns are shown when available from the Fidelity Performance PDF. Cost basis
        return is always shown as a permanent baseline.
      </p>
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
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {AGGREGATE_SCOPES.flatMap((scope) => {
                const results = aggregateByScope.get(scope) ?? [];
                return FIDELITY_PERIODS.map((period) => {
                  const result = results.find((r) => r.period === period);
                  return (
                    <tr key={`${scope}-${period}`}>
                      <td>{SCOPE_LABELS[scope]}</td>
                      <td>{PERIOD_LABELS[period]}</td>
                      <td className="mono">{formatPercent(result?.portfolioReturn ?? null)}</td>
                      <td className="mono">{formatPercent(result?.sp500Return ?? null)}</td>
                      <td className="mono" style={{ color: alphaColor(result?.alpha ?? null) }}>
                        {formatPercent(result?.alpha ?? null)}
                      </td>
                      <td className="mono" style={{ color: "var(--text-muted)" }}>
                        {result?.portfolioReturn == null
                          ? "Not yet reported"
                          : `As of ${formatDate(result.asOfDate)}`}
                        {result && result.excludedAccountIds.length > 0
                          ? ` — ${result.excludedAccountIds.length} account(s) not yet reported`
                          : ""}
                      </td>
                    </tr>
                  );
                });
              })}
              {aggregateSincePurchase && (
                <tr>
                  <td>All Accounts</td>
                  <td>Since Purchase (cost basis)</td>
                  <td className="mono">{formatPercent(aggregateSincePurchase.portfolioReturn)}</td>
                  <td className="mono">{formatPercent(aggregateSincePurchase.sp500Return)}</td>
                  <td className="mono" style={{ color: alphaColor(aggregateSincePurchase.alpha) }}>
                    {formatPercent(aggregateSincePurchase.alpha)}
                  </td>
                  <td className="mono" style={{ color: "var(--text-muted)" }}>
                    {formatCurrency(aggregateSincePurchase.costBasis)} →{" "}
                    {formatCurrency(aggregateSincePurchase.currentValue)}
                  </td>
                </tr>
              )}
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
            {results.length === 0 && !sincePurchase ? (
              <p style={{ color: "var(--text-muted)" }}>
                No position data yet — import a statement to see benchmark data.
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
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {FIDELITY_PERIODS.map((period) => {
                      const result = results.find((r) => r.period === period);
                      return (
                        <tr key={period}>
                          <td>{PERIOD_LABELS[period]}</td>
                          <td className="mono">{formatPercent(result?.portfolioReturn ?? null)}</td>
                          <td className="mono">{formatPercent(result?.sp500Return ?? null)}</td>
                          <td className="mono" style={{ color: alphaColor(result?.alpha ?? null) }}>
                            {formatPercent(result?.alpha ?? null)}
                          </td>
                          <td className="mono" style={{ color: "var(--text-muted)" }}>
                            {result?.portfolioReturn == null
                              ? "Not yet reported"
                              : `As of ${formatDate(result.asOfDate)}`}
                          </td>
                        </tr>
                      );
                    })}
                    {sincePurchase && (
                      <tr>
                        <td>Since Purchase (cost basis)</td>
                        <td className="mono">{formatPercent(sincePurchase.portfolioReturn)}</td>
                        <td className="mono">{formatPercent(sincePurchase.sp500Return)}</td>
                        <td className="mono" style={{ color: alphaColor(sincePurchase.alpha) }}>
                          {formatPercent(sincePurchase.alpha)}
                        </td>
                        <td className="mono" style={{ color: "var(--text-muted)" }}>
                          {formatCurrency(sincePurchase.costBasis)} → {formatCurrency(sincePurchase.currentValue)}
                          {" (no purchase date on record — S&P 500 side estimated from "}
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
