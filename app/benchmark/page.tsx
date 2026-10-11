import { prisma } from "@/lib/prisma";
import { computeBenchmark, FIDELITY_PERIODS } from "@/lib/benchmark/engine";
import type { AccountBenchmarkResult, BenchmarkComputation, FidelityPeriodKey } from "@/lib/benchmark/engine";
import { loadBenchmarkDisplay, type BenchmarkDisplay } from "@/lib/benchmark/displayData";
import type { DisplayRow, DisplayWindow } from "@/lib/benchmark/displayRows";
import { formatCurrency, formatDate } from "@/lib/format";
import { BenchmarkAccountPicker, type BenchmarkScopeView } from "./BenchmarkAccountPicker";

export const dynamic = "force-dynamic";

const PERIOD_LABELS: Record<FidelityPeriodKey, string> = {
  ytd: "YTD",
  "1y": "1 Year",
  "3y": "3 Year (annualized)",
};

function windowDetail(w: DisplayWindow): string {
  if (w.status === "too_young") return "Account is younger than this window — not shown";
  if (w.status === "no_data") return "Not yet reported";
  const parts = [`As of ${formatDate(w.asOf)}`, `from ${formatDate(w.windowStart)}`];
  if (w.source === "proxy_vz_total_return") parts.push("proxy: VZ stock total return");
  return parts.join(" · ");
}

function toPeriods(row: DisplayRow | null) {
  return FIDELITY_PERIODS.map((period) => {
    const w = row?.windows[period];
    return {
      period,
      label: PERIOD_LABELS[period],
      portfolioReturn: w?.returnPct ?? null,
      sp500Return: w?.sp500 ?? null,
      alpha: w?.alpha ?? null,
      detail: w ? windowDetail(w) : "Not yet reported",
    };
  });
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

  let display: BenchmarkDisplay = { total: null, accounts: [], warnings: [] };
  try {
    display = await loadBenchmarkDisplay(computation);
  } catch (err) {
    console.error("loadBenchmarkDisplay failed:", err);
  }
  const displayById = new Map(display.accounts.map((r) => [r.key, r]));

  const totalPortfolioView: BenchmarkScopeView = {
    id: "TOTAL",
    label: "Total Portfolio",
    meta: "All accounts, value-weighted · S&P 500 total return over each row's own dates",
    periods: toPeriods(display.total),
  };

  const accountViews: BenchmarkScopeView[] = accounts.map((account) => {
    const results = accountResultsByAccount.get(account.id) ?? [];
    // currentLockedValue/currentActionableValue are point-in-time (not period-specific) and identical across every period row for this account, so any row works.
    const currentSlice = results[0];
    const concentration =
      currentSlice && currentSlice.currentLockedValue > 0
        ? {
            lockedValue: currentSlice.currentLockedValue,
            actionableValue: currentSlice.currentActionableValue,
            totalValue: currentSlice.endValue,
          }
        : null;
    return {
      id: account.id,
      label: account.name,
      meta: `${account.type}${account.isLocked ? " · Locked" : ""}${displayById.get(account.id)?.asOf ? ` · as of ${formatDate(displayById.get(account.id)!.asOf)}` : ""}`,
      concentration,
      periods: toPeriods(displayById.get(account.id) ?? null),
    };
  });

  return (
    <div>
      <h1>Benchmark</h1>

      <p>
        {/* Plain same-origin link: Content-Disposition makes Safari (incl. iPad) download it, no JS needed. */}
        <a href="/api/export/snapshot" download className="button" style={{ display: "inline-block", padding: "0.5rem 1rem", border: "1px solid var(--border, #888)", borderRadius: "6px", textDecoration: "none" }}>
          Export snapshot
        </a>
      </p>

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
        Returns come from the Fidelity Performance PDF (Total Portfolio uses the PDF&apos;s Total row when
        uploaded). Every S&amp;P 500 figure is the total-return index computed over that row&apos;s own dates; 3Y
        is annualized. A window longer than the account&apos;s life shows no figure.
      </p>
      {display.warnings.length > 0 && (
        <ul style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
          {display.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <BenchmarkAccountPicker views={[totalPortfolioView, ...accountViews]} />

      {accounts.length === 0 && (
        <p style={{ color: "var(--text-muted)" }}>No accounts yet — add one and import a statement first.</p>
      )}
    </div>
  );
}
