import { countOperationalOpenAutoTickers } from "@/lib/trades/operational";

type BrokerTruthLike = {
  error?: string | null;
  positionsCount?: number | null;
  positions?: Array<unknown> | null;
};

export type OperationalDiagnostics = {
  brokerPositionsCount: number;
  dbOpenTradesCount: number;
  dbAutoOpenTradesCount: number;
  dbActualOperationalCount: number;
  openTradesMismatch: boolean;
  mismatchNote: string | null;
};

export function computeOperationalDiagnostics(
  brokerTruth: BrokerTruthLike | null | undefined,
  trades: unknown,
): OperationalDiagnostics {
  const brokerPositionsCount =
    typeof brokerTruth?.positionsCount === "number"
      ? brokerTruth.positionsCount
      : Array.isArray(brokerTruth?.positions)
        ? brokerTruth.positions.length
        : 0;

  const safeTrades = Array.isArray(trades) ? trades : [];

  // Keep parity with /api/ops/status operational truth semantics.
  // dbOpenTradesCount and dbActualOperationalCount are authoritative broker-truth counts.
  const dbOpenTradesCount = brokerPositionsCount;
  const dbActualOperationalCount = brokerPositionsCount;
  const dbAutoOpenTradesCount = countOperationalOpenAutoTickers(safeTrades);

  const openTradesMismatch = brokerTruth?.error ? false : brokerPositionsCount !== dbActualOperationalCount;

  return {
    brokerPositionsCount,
    dbOpenTradesCount,
    dbAutoOpenTradesCount,
    dbActualOperationalCount,
    openTradesMismatch,
    mismatchNote: openTradesMismatch
      ? `DB operational count=${dbActualOperationalCount} but broker positions=${brokerPositionsCount}. Run reconcile-open-trades to cleanup stale conflicts.`
      : null,
  };
}
