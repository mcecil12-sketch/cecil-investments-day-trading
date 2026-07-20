import { prisma } from "@/lib/prisma";
import type { ImportBatchStatus } from "@/lib/generated/prisma";
import { getHoldingSector } from "@/lib/agents/sectorRotation";
import type { SectorRotationOutput } from "@/lib/agents/sectorRotation";
import type { RelativeStrengthOutput, RelativeStrengthEntry } from "@/lib/agents/relativeStrength";

const USABLE_STATUSES: ImportBatchStatus[] = ["COMPLETE", "PARTIAL"];

/** Household context from the owner — used both in the CIO prompt and as the raw figure passed alongside the computed data. */
export const TAXABLE_CAPITAL_GAINS_CAPACITY = 150_000;

/** A sector ETF's rotation score is only worth citing as "leading with no taxable exposure" above this rank. */
const LEADING_SECTOR_RANK_CUTOFF = 5;

export interface TaxablePositionSummary {
  symbol: string;
  name: string | null;
  totalValue: number;
  totalCostBasis: number;
  gainLoss: number;
  gainLossPct: number | null;
  percentOfTaxablePortfolio: number;
  accounts: Array<{ accountName: string; value: number }>;
}

export interface TaxableSectorExposure {
  sector: string;
  value: number;
  percentOfTaxablePortfolio: number;
  rotationScore: number | null;
  rotationRank: number | null;
}

export interface TaxableAnalysisContext {
  totalTaxableValue: number;
  capitalGainsCapacity: number;
  positions: TaxablePositionSummary[];
  fselxConcentrationPct: number;
  sectorExposure: TaxableSectorExposure[];
  /** Sectors ranked in the top LEADING_SECTOR_RANK_CUTOFF by the Sector Rotation agent that have zero current taxable exposure. */
  leadingSectorsWithZeroExposure: Array<{ sector: string; symbol: string; score: number; rank: number }>;
  /** The taxable-held FSELX position's own Relative Strength read, when available — the most direct available signal for "has the semiconductor sector weakened," since FSELX is itself a concentrated semiconductor fund. */
  fselxMomentum: RelativeStrengthEntry | null;
  /** A handful of the highest-scoring holdings/candidates from Relative Strength, regardless of account, as raw material for "worth adding to." */
  momentumLeaders: RelativeStrengthEntry[];
}

/**
 * Recomputes portfolio exposure scoped to just the five taxable Fidelity
 * accounts, joined with the already-computed Sector Rotation and Relative
 * Strength agent outputs — no new market-data fetches, since both agents
 * already ran this week as part of the same pipeline. Returns null if there
 * are no taxable accounts with data yet.
 */
export async function buildTaxableAnalysisContext(
  sectorOutput: SectorRotationOutput | null,
  relativeOutput: RelativeStrengthOutput | null,
): Promise<TaxableAnalysisContext | null> {
  const taxableAccounts = await prisma.account.findMany({ where: { type: "FIDELITY_TAXABLE" } });
  if (taxableAccounts.length === 0) return null;

  const positionsBySymbol = new Map<
    string,
    { symbol: string; name: string | null; totalValue: number; totalCostBasis: number; accounts: Map<string, number> }
  >();
  let totalTaxableValue = 0;

  for (const account of taxableAccounts) {
    const batch = await prisma.importBatch.findFirst({
      where: { accountId: account.id, status: { in: USABLE_STATUSES } },
      orderBy: [{ asOfDate: "desc" }, { uploadedAt: "desc" }],
      select: { id: true },
    });
    if (!batch) continue;

    const holdings = await prisma.holding.findMany({
      where: { importBatchId: batch.id },
      include: { instrument: true },
    });

    for (const holding of holdings) {
      totalTaxableValue += holding.currentValue;
      if (holding.instrument.type === "CASH") continue;

      const key = holding.instrument.symbol;
      const entry = positionsBySymbol.get(key) ?? {
        symbol: key,
        name: holding.instrument.name,
        totalValue: 0,
        totalCostBasis: 0,
        accounts: new Map<string, number>(),
      };
      entry.totalValue += holding.currentValue;
      entry.totalCostBasis += holding.costBasisTotal ?? holding.currentValue;
      entry.accounts.set(account.name, (entry.accounts.get(account.name) ?? 0) + holding.currentValue);
      positionsBySymbol.set(key, entry);
    }
  }

  if (totalTaxableValue === 0) return null;

  const positions: TaxablePositionSummary[] = Array.from(positionsBySymbol.values())
    .map((entry) => {
      const gainLoss = entry.totalValue - entry.totalCostBasis;
      return {
        symbol: entry.symbol,
        name: entry.name,
        totalValue: entry.totalValue,
        totalCostBasis: entry.totalCostBasis,
        gainLoss,
        gainLossPct: entry.totalCostBasis > 0 ? gainLoss / entry.totalCostBasis : null,
        percentOfTaxablePortfolio: entry.totalValue / totalTaxableValue,
        accounts: Array.from(entry.accounts.entries()).map(([accountName, value]) => ({ accountName, value })),
      };
    })
    .sort((a, b) => b.totalValue - a.totalValue);

  const fselxConcentrationPct =
    positions.find((p) => p.symbol === "FSELX")?.percentOfTaxablePortfolio ?? 0;

  const exposureMap = new Map<string, number>();
  for (const position of positions) {
    const sector = getHoldingSector(position.symbol, position.name) ?? "Unclassified";
    exposureMap.set(sector, (exposureMap.get(sector) ?? 0) + position.totalValue);
  }

  const sectorExposure: TaxableSectorExposure[] = Array.from(exposureMap.entries())
    .map(([sector, value]) => {
      const ranked = sectorOutput?.rankedSectors.find((r) => r.sector === sector) ?? null;
      return {
        sector,
        value,
        percentOfTaxablePortfolio: value / totalTaxableValue,
        rotationScore: ranked?.score ?? null,
        rotationRank: ranked?.rank ?? null,
      };
    })
    .sort((a, b) => b.value - a.value);

  const exposedSectors = new Set(sectorExposure.filter((e) => e.value > 0).map((e) => e.sector));
  const leadingSectorsWithZeroExposure = (sectorOutput?.rankedSectors ?? [])
    .filter((s) => s.rank <= LEADING_SECTOR_RANK_CUTOFF && !exposedSectors.has(s.sector))
    .map((s) => ({ sector: s.sector, symbol: s.symbol, score: s.score, rank: s.rank }));

  const fselxMomentum = relativeOutput?.allHoldings.find((h) => h.symbol === "FSELX") ?? null;
  const momentumLeaders = [...(relativeOutput?.topHoldings ?? []), ...(relativeOutput?.candidates ?? [])];

  return {
    totalTaxableValue,
    capitalGainsCapacity: TAXABLE_CAPITAL_GAINS_CAPACITY,
    positions,
    fselxConcentrationPct,
    sectorExposure,
    leadingSectorsWithZeroExposure,
    fselxMomentum,
    momentumLeaders,
  };
}
