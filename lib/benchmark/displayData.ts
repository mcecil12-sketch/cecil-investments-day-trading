import { prisma } from "@/lib/prisma";
import type { BenchmarkComputation, FidelityPeriodKey } from "@/lib/benchmark/engine";
import { loadAdjustedSeries, loadSp500TotalReturnSeries, type ComparatorPeriod } from "@/lib/benchmark/sp500Comparator";
import { buildBenchmarkWarnings, buildLtiDisplayRow, buildPdfDisplayRow, type DisplayRow, type PdfPeriodInput } from "@/lib/benchmark/displayRows";
import { VZ_SYMBOL } from "@/lib/agents/marketData";

export interface BenchmarkDisplay {
  total: DisplayRow | null;
  accounts: DisplayRow[];
  warnings: string[];
}

const PERIODS: FidelityPeriodKey[] = ["ytd", "1y", "3y"];

/**
 * Display rows (one comparator, per-row as-of windows) for the Benchmark page
 * and the snapshot export. Reads engine output as-is — no engine/benchmark
 * math changes. Never throws: a Yahoo outage yields rows with "—" S&P figures.
 */
export async function loadBenchmarkDisplay(computation: BenchmarkComputation): Promise<BenchmarkDisplay> {
  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
  const lifeRows = await prisma.accountPerformance.findMany({ where: { period: "life", isAggregate: false }, orderBy: { asOfDate: "desc" } });
  const inception = new Map<string, Date>();
  for (const r of lifeRows) if (r.accountId && r.startDate && !inception.has(r.accountId)) inception.set(r.accountId, r.startDate);

  let sp500: Awaited<ReturnType<typeof loadSp500TotalReturnSeries>> = [];
  let vz: typeof sp500 = [];
  try {
    sp500 = await loadSp500TotalReturnSeries();
  } catch (err) {
    console.error("S&P TR series unavailable:", err instanceof Error ? err.message : err);
  }
  try {
    if (accounts.some((a) => a.type === "VZ_LTI")) vz = await loadAdjustedSeries(VZ_SYMBOL);
  } catch (err) {
    console.error("VZ series unavailable:", err instanceof Error ? err.message : err);
  }

  const rows: DisplayRow[] = [];
  for (const account of accounts) {
    const results = computation.accounts.filter((r) => r.accountId === account.id);
    const value = results[0]?.endValue ?? 0;
    if (account.type === "VZ_LTI") {
      rows.push(buildLtiDisplayRow({ key: account.id, name: account.name, type: account.type, value }, vz, sp500));
      continue;
    }
    const pdf: Partial<Record<ComparatorPeriod, PdfPeriodInput>> = {};
    for (const p of PERIODS) {
      const r = results.find((x) => x.period === p);
      if (r) pdf[p] = { returnPct: r.portfolioReturn, pdfSp500: r.sp500Return, asOf: r.asOfDate };
    }
    rows.push(buildPdfDisplayRow({ key: account.id, name: account.name, type: account.type, value, inceptionDate: inception.get(account.id) ?? null, pdf }, sp500));
  }

  let total: DisplayRow | null = null;
  const totals = computation.aggregate.filter((r) => r.scope === "AGGREGATE_TOTAL");
  if (totals.length > 0) {
    const pdf: Partial<Record<ComparatorPeriod, PdfPeriodInput>> = {};
    for (const p of PERIODS) {
      const r = totals.find((x) => x.period === p);
      if (!r) continue;
      // A value-weighted blend (no PDF Total row) is stamped with today's snapshot date by the engine; the returns inside it are only as fresh as the contributing PDF rows, so use their latest as-of for the window.
      let asOf: Date | null = r.asOfDate;
      if (!r.sourcedFromTotalRow) {
        const dates = computation.accounts.filter((a) => a.period === p && r.accountIds.includes(a.accountId) && a.asOfDate).map((a) => a.asOfDate!.getTime());
        asOf = dates.length > 0 ? new Date(Math.max(...dates)) : null;
      }
      pdf[p] = { returnPct: r.portfolioReturn, pdfSp500: r.sp500Return, asOf };
    }
    total = buildPdfDisplayRow({ key: "TOTAL", name: "Total Portfolio", type: "TOTAL", value: computation.totalCurrentValue, inceptionDate: null, pdf }, sp500);
  }

  // The Total row is a blend of accounts with mixed dates, so only the per-account rows feed the as-of/mismatch warnings.
  return { total, accounts: rows, warnings: buildBenchmarkWarnings(rows) };
}
