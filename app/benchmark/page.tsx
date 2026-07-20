import { prisma } from "@/lib/prisma";
import { computeBenchmark, FIDELITY_PERIODS } from "@/lib/benchmark/engine";
import type {
  AccountBenchmarkResult,
  AccountSincePurchaseResult,
  AggregateBenchmarkResult,
  BenchmarkComputation,
  FidelityPeriodKey,
} from "@/lib/benchmark/engine";
import { formatCurrency, formatDate } from "@/lib/format";
import { BenchmarkAccountPicker, type BenchmarkScopeView } from "./BenchmarkAccountPicker";

export const dynamic = "force-dynamic";

const PERIOD_LABELS: Record<FidelityPeriodKey, string> = {
  ytd: "YTD",
  "1y": "1 Year",
  "3y": "3 Year",
};

function aggregatePeriodDetail(result: AggregateBenchmarkResult | undefined): string {
  if (!result || result.portfolioReturn == null) return "Not yet reported";
  if (result.sourcedFromTotalRow) return `As of ${formatDate(result.asOfDate)} (Fidelity Total row)`;
  const excluded = result.excludedAccountIds.length > 0 ? ` — ${result.excludedAccountIds.length} account(s) not yet reported` : "";
  return `As of ${formatDate(result.asOfDate)}${excluded}`;
}

function accountPeriodDetail(result: AccountBenchmarkResult | undefined): string {
  if (!result || result.portfolioReturn == null) return "Not yet reported";
  return `As of ${formatDate(result.asOfDate)}`;
}

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

  const totalResultsByPeriod = new Map<FidelityPeriodKey, AggregateBenchmarkResult>();
  for (const result of computation.aggregate) {
    if (result.scope === "AGGREGATE_TOTAL") totalResultsByPeriod.set(result.period, result);
  }

  const sincePurchaseByAccount = new Map<string, AccountSincePurchaseResult>();
  for (const result of computation.sincePurchase) {
    sincePurchaseByAccount.set(result.accountId, result);
  }

  const aggregateSincePurchase = computation.aggregateSincePurchase;

  const totalPortfolioView: BenchmarkScopeView = {
    id: "TOTAL",
    label: "Total Portfolio",
    meta: "All accounts, value-weighted",
    periods: FIDELITY_PERIODS.map((period) => {
      const result = totalResultsByPeriod.get(period);
      return {
        period,
        label: PERIOD_LABELS[period],
        portfolioReturn: result?.portfolioReturn ?? null,
        sp500Return: result?.sp500Return ?? null,
        alpha: result?.alpha ?? null,
        detail: aggregatePeriodDetail(result),
      };
    }),
    sincePurchase: aggregateSincePurchase
      ? {
          portfolioReturn: aggregateSincePurchase.portfolioReturn,
          sp500Return: aggregateSincePurchase.sp500Return,
          alpha: aggregateSincePurchase.alpha,
          detail: `${formatCurrency(aggregateSincePurchase.costBasis)} → ${formatCurrency(aggregateSincePurchase.currentValue)}`,
        }
      : null,
  };

  const accountViews: BenchmarkScopeView[] = accounts.map((account) => {
    const results = accountResultsByAccount.get(account.id) ?? [];
    const sincePurchase = sincePurchaseByAccount.get(account.id);
    return {
      id: account.id,
      label: account.name,
      meta: `${account.type}${account.isLocked ? " · Locked" : ""}`,
      periods: FIDELITY_PERIODS.map((period) => {
        const result = results.find((r) => r.period === period);
        return {
          period,
          label: PERIOD_LABELS[period],
          portfolioReturn: result?.portfolioReturn ?? null,
          sp500Return: result?.sp500Return ?? null,
          alpha: result?.alpha ?? null,
          detail: accountPeriodDetail(result),
        };
      }),
      sincePurchase: sincePurchase
        ? {
            portfolioReturn: sincePurchase.portfolioReturn,
            sp500Return: sincePurchase.sp500Return,
            alpha: sincePurchase.alpha,
            detail: `${formatCurrency(sincePurchase.costBasis)} → ${formatCurrency(sincePurchase.currentValue)} (no purchase date on record — S&P 500 side estimated from ${formatDate(sincePurchase.estimatedHoldingStart)})`,
          }
        : null,
    };
  });

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

      <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
        Rolling period returns are shown when available from the Fidelity Performance PDF — Total Portfolio
        uses the PDF&apos;s own Total row when uploaded, otherwise a value-weighted blend of each account&apos;s
        reported return. Cost basis return is always shown as a permanent baseline.
      </p>

      <BenchmarkAccountPicker views={[totalPortfolioView, ...accountViews]} />

      {accounts.length === 0 && (
        <p style={{ color: "var(--text-muted)" }}>No accounts yet — add one and import a statement first.</p>
      )}
    </div>
  );
}
