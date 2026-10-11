import { prisma } from "@/lib/prisma";
import { computeBenchmark } from "@/lib/benchmark/engine";
import { buildTaxableAnalysisContext } from "@/lib/agents/taxableAnalysis";
import { groupIntoMonthlyRankings } from "@/lib/agents/recommendationPerformance";
import { buildBandedMonthlyPositions, currentlyHeldSymbols, BUY_RANK_THRESHOLD } from "@/lib/agents/monthlyScanBanding";
import type { RelativeStrengthOutput } from "@/lib/agents/relativeStrength";
import type { PerformanceAnalystOutput } from "@/lib/agents/performanceAnalyst";
import { getLatestScanHealth } from "@/lib/agents/scanHealth";
import { loadBenchmarkDisplay } from "@/lib/benchmark/displayData";
import { loadAdjustedSeries, loadSp500TotalReturnSeries } from "@/lib/benchmark/sp500Comparator";
import { averagePairwiseCorrelation, computeAllocation, computeSleeveScoreboard, computeThemeConcentration } from "@/lib/export/sleeveMath";
import { getVzExposure } from "@/lib/portfolio/vzExposureData";
import type { AgentType } from "@/lib/generated/prisma";
import type { SnapshotAccountRow, SnapshotAnalystText, SnapshotData } from "@/lib/export/snapshotMarkdown";

const ACCOUNT_TYPES = ["FIDELITY_TAXABLE", "VZ_SAVINGS_401K", "VZ_LEGACY_401K", "VZ_EDP", "VZ_LTI"] as const;

async function lastRunAt(agentType: AgentType): Promise<Date | null> {
  const run = await prisma.agentRun.findFirst({
    where: { agentType, status: "COMPLETE" },
    orderBy: { startedAt: "desc" },
    select: { completedAt: true, startedAt: true },
  });
  return run ? (run.completedAt ?? run.startedAt) : null;
}

function toAnalystText(raw: unknown): SnapshotAnalystText | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<PerformanceAnalystOutput>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    topWinnerPatterns: arr(o.topWinnerPatterns),
    topLoserPatterns: arr(o.topLoserPatterns),
    bestSetupTypes: arr(o.bestSetupTypes),
    scoreVsRealizedRNote: typeof o.scoreVsRealizedRNote === "string" ? o.scoreVsRealizedRNote : "",
    earlyExitPatterns: arr(o.earlyExitPatterns),
    sentimentSignalNote: typeof o.sentimentSignalNote === "string" ? o.sentimentSignalNote : null,
    fragilityNote: typeof o.fragilityNote === "string" ? o.fragilityNote : null,
    insiderNote: typeof o.insiderNote === "string" ? o.insiderNote : null,
  };
}

/** Gathers every snapshot section independently; a failing section becomes null + a loadErrors entry. */
export async function loadSnapshotData(now: Date = new Date()): Promise<SnapshotData> {
  const loadErrors: Record<string, string> = {};
  const guard = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      loadErrors[name] = err instanceof Error ? err.message.split("\n")[0].slice(0, 120) : "unknown error";
      return null;
    }
  };

  const accounts = await guard("accounts", () => prisma.account.findMany({ orderBy: { createdAt: "asc" } }));
  const lastImportByAccount = new Map<string, Date>();
  if (accounts) {
    for (const a of accounts) {
      const batch = await guard("imports", () =>
        prisma.importBatch.findFirst({
          where: { accountId: a.id, status: { in: ["COMPLETE", "PARTIAL"] } },
          orderBy: { uploadedAt: "desc" },
          select: { uploadedAt: true },
        }),
      );
      if (batch) lastImportByAccount.set(a.id, batch.uploadedAt);
    }
  }

  const computation = await guard("portfolio", () => computeBenchmark());

  const display = computation ? await guard("benchmark display", () => loadBenchmarkDisplay(computation)) : null;
  const portfolio: SnapshotData["portfolio"] =
    computation && accounts
      ? {
          totalValue: computation.totalCurrentValue,
          accounts: accounts.map((a): SnapshotAccountRow => {
            const row = display?.accounts.find((r) => r.key === a.id);
            const emptyWindow = (period: "ytd" | "1y" | "3y") => ({ period, status: "no_data" as const, returnPct: null, sp500: null, alpha: null, pdfSp500: null, asOf: null, windowStart: null, annualized: period === "3y", source: null });
            return {
              name: a.name,
              type: a.type,
              value: row?.value ?? computation.accounts.find((r) => r.accountId === a.id)?.endValue ?? 0,
              asOf: row?.asOf ?? null,
              windows: row?.windows ?? { ytd: emptyWindow("ytd"), "1y": emptyWindow("1y"), "3y": emptyWindow("3y") },
              lastImportAt: lastImportByAccount.get(a.id) ?? null,
            };
          }),
        }
      : null;

  const freshness = await guard("freshness", async () => {
    const [weekly, monthly, sentiment, covered, brief] = await Promise.all([
      lastRunAt("CANDIDATE_SCANNER"),
      lastRunAt("MONTHLY_SCAN"),
      lastRunAt("SENTIMENT_REFRESH"),
      prisma.sentimentFetchState.count({ where: { hasCoverage: true } }),
      prisma.weeklyBrief.findFirst({ orderBy: { weekOf: "desc" }, select: { createdAt: true } }),
    ]);
    return {
      lastImportByAccountType: ACCOUNT_TYPES.map((t) => {
        const dates = (accounts ?? []).filter((a) => a.type === t).map((a) => lastImportByAccount.get(a.id)).filter((d): d is Date => !!d);
        return { accountType: t, at: dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null };
      }),
      lastWeeklyScan: weekly,
      lastMonthlyScan: monthly,
      lastWeeklyBrief: brief?.createdAt ?? null,
      lastSentimentRun: sentiment,
      sentimentCoveredSymbols: covered,
    };
  });

  const vz = await guard("vz", () => getVzExposure(computation?.totalCurrentValue ?? null));

  const group3Rows = await guard("group3", () =>
    prisma.candidateRecommendationLog.findMany({ where: { group: "GROUP_3" }, orderBy: { recommendedAt: "asc" } }),
  );

  const rsRun = await guard("taxable", () =>
    prisma.agentRun.findFirst({ where: { agentType: "RELATIVE_STRENGTH", status: "COMPLETE" }, orderBy: { startedAt: "desc" }, select: { output: true } }),
  );
  const taxableCtx = await guard("taxable", () => buildTaxableAnalysisContext(null, null));

  const latestLogBySymbol = new Map<string, NonNullable<typeof group3Rows>[number]>();
  for (const row of group3Rows ?? []) latestLogBySymbol.set(row.symbol, row); // ascending order: last write wins

  const rsScores = new Map<string, number>(
    ((rsRun?.output as unknown as RelativeStrengthOutput | null)?.allHoldings ?? []).map((h) => [h.symbol, h.score]),
  );

  const taxable: SnapshotData["taxable"] = taxableCtx
    ? taxableCtx.positions.map((p) => {
        const log = latestLogBySymbol.get(p.symbol);
        return {
          symbol: p.symbol,
          weight: p.percentOfTaxablePortfolio,
          unrealizedGain: p.gainLoss,
          compositeScore: rsScores.get(p.symbol) ?? null,
          fragilityFlag: log?.fragilityFlag ?? null,
          insiderNetSoldUsd30d: log?.insiderNetSoldUsd30d ?? null,
        };
      })
    : taxableCtx === null && !loadErrors.taxable
      ? []
      : null;

  let group3: SnapshotData["group3"] = null;
  if (group3Rows) {
    const rankings = groupIntoMonthlyRankings(group3Rows);
    const latest = rankings.at(-1);
    if (latest) {
      const held = currentlyHeldSymbols(rankings);
      const taxableSymbols = new Set((taxableCtx?.positions ?? []).map((p) => p.symbol));
      const batchRows = new Map(group3Rows.filter((r) => r.batchTag === latest.monthKey).map((r) => [r.symbol, r]));
      group3 = {
        monthKey: latest.monthKey,
        batchDate: latest.date,
        top10: latest.rankedSymbols.slice(0, BUY_RANK_THRESHOLD).map((s, i) => {
          const row = batchRows.get(s.symbol);
          return {
            rank: i + 1,
            symbol: s.symbol,
            score: s.score,
            tracked: held.has(s.symbol),
            inTaxableAccount: taxableSymbols.has(s.symbol),
            fragilityFlag: row?.fragilityFlag ?? null,
            insiderNetSoldUsd30d: row?.insiderNetSoldUsd30d ?? null,
          };
        }),
        sellCandidates: buildBandedMonthlyPositions(rankings)
          .filter((p) => p.exitDate?.getTime() === latest.date.getTime())
          .map((p) => p.symbol),
      };
    }
  }

  // Per-account allocation + sleeve (Group 3 top-10 names held in taxable accounts).
  const taxableAccounts = (accounts ?? []).filter((a) => a.type === "FIDELITY_TAXABLE");
  const taxableHoldings = await guard("allocation", async () => {
    const out: Array<{ name: string; holdings: Array<{ symbol: string; isCash: boolean; value: number }> }> = [];
    for (const a of taxableAccounts) {
      const batch = await prisma.importBatch.findFirst({
        where: { accountId: a.id, status: { in: ["COMPLETE", "PARTIAL"] }, holdings: { some: {} } },
        orderBy: [{ asOfDate: "desc" }, { uploadedAt: "desc" }],
        select: { id: true },
      });
      const rows = batch ? await prisma.holding.findMany({ where: { importBatchId: batch.id }, include: { instrument: true } }) : [];
      out.push({ name: a.name, holdings: rows.map((h) => ({ symbol: h.instrument.symbol, isCash: h.instrument.type === "CASH", value: h.currentValue })) });
    }
    return out;
  });
  const top10Symbols = new Set((group3?.top10 ?? []).map((r) => r.symbol));
  const heldTaxable = new Set((taxableHoldings ?? []).flatMap((a) => a.holdings.filter((h) => !h.isCash).map((h) => h.symbol)));
  const sleeveSymbols = [...top10Symbols].filter((s) => heldTaxable.has(s));
  const allocation = taxableHoldings ? computeAllocation(taxableHoldings, new Set(sleeveSymbols)) : null;

  const CONTROL_SYMBOL = "FXAIX";
  let sleeve: SnapshotData["sleeve"] = null;
  if (group3?.batchDate && sleeveSymbols.length > 0) {
    const sleeveResult = await guard("sleeve", async () => {
      const [index, control] = await Promise.all([loadSp500TotalReturnSeries(), loadAdjustedSeries(CONTROL_SYMBOL).catch(() => null)]);
      const names = await Promise.all(
        sleeveSymbols.map(async (symbol) => ({ symbol, series: await loadAdjustedSeries(symbol).catch(() => [] as Awaited<ReturnType<typeof loadAdjustedSeries>>) })),
      );
      const sectorBySymbol = new Map((group3Rows ?? []).filter((r) => r.batchTag === group3!.monthKey).map((r) => [r.symbol, r.sector]));
      return {
        scoreboard: computeSleeveScoreboard({ startDate: group3!.batchDate!, names, index, control }),
        theme: computeThemeConcentration(sleeveSymbols.map((symbol) => ({ symbol, sector: sectorBySymbol.get(symbol) ?? null }))),
        avgCorrelation60d: averagePairwiseCorrelation(names.filter((n) => n.series.length > 0).map((n) => n.series), 60),
        sleeveSize: sleeveSymbols.length,
        controlSymbol: CONTROL_SYMBOL,
      };
    });
    sleeve = sleeveResult ?? { scoreboard: null, theme: null, avgCorrelation60d: null, sleeveSize: sleeveSymbols.length, controlSymbol: CONTROL_SYMBOL, unavailableReason: loadErrors.sleeve };
  } else if (group3) {
    sleeve = { scoreboard: null, theme: null, avgCorrelation60d: null, sleeveSize: 0, controlSymbol: CONTROL_SYMBOL, unavailableReason: "no Group 3 top-10 names held in taxable accounts" };
  }

  const brief = await guard("brief", async () => {
    const b = await prisma.weeklyBrief.findFirst({ orderBy: { weekOf: "desc" } });
    return b ? { weekOf: b.weekOf, cioSummary: b.cioSummary, performanceAnalysis: toAnalystText(b.performanceAnalysis) } : null;
  });

  const scanHealth = await guard("scanHealth", () => getLatestScanHealth());

  return { generatedAt: now, freshness, portfolio, vz, taxable, group3, allocation, sleeve, benchmarkWarnings: display?.warnings ?? [], brief, scanHealth, loadErrors };
}
