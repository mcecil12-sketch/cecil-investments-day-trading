import { readTodayFunnel } from "@/lib/funnelRedis";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import { readSignals } from "@/lib/jsonDb";
import { getGuardrailConfig } from "@/lib/autoEntry/guardrails";
import { getAutoEntryEnabledState, getGuardrailsState } from "@/lib/autoEntry/guardrailsStore";
import { getEtDateString } from "@/lib/agents/time";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { readTrades } from "@/lib/tradesStore";
import { countOperationalOpenTickers } from "@/lib/trades/operational";

type TelemetrySignalsSnapshot = {
  pendingCount: number;
  scoredCount: number;
  zeroScoreCount: number;
  latestScoredAt: string | null;
};

export type AgentTelemetrySnapshot = {
  nowIso: string;
  etDate: string;
  marketOpen: boolean | null;
  readinessReady: boolean;
  readinessReasons: string[];
  staleScoring: boolean;
  staleScanner: boolean;
  autoEntryDisabled: boolean;
  autoEntryDisableReason: string | null;
  openTradeMismatch: boolean;
  brokerPositionsCount: number;
  dbOperationalOpenCount: number;
  signalsPendingCount: number;
  signalsScoredCount: number;
  zeroScoreCount: number;
};

const STALE_SCORING_MINUTES = Number(process.env.AGENTS_STALE_SCORING_MINUTES ?? "20");
const STALE_SCANNER_MINUTES = Number(process.env.AGENTS_STALE_SCANNER_MINUTES ?? "15");
const SIGNAL_WINDOW_HOURS = Number(process.env.AGENTS_SIGNAL_WINDOW_HOURS ?? "48");

function toTimestamp(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(value);
}

function minutesSince(value: string | null): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return (Date.now() - ts) / 60000;
}

function summarizeSignals(): Promise<TelemetrySignalsSnapshot> {
  return readSignals().then((signals) => {
    const cutoff = Date.now() - Math.max(1, SIGNAL_WINDOW_HOURS) * 60 * 60 * 1000;
    const recent = (Array.isArray(signals) ? signals : []).filter((signal: any) => {
      const created = toTimestamp(signal?.createdAt);
      return Number.isFinite(created) && created >= cutoff;
    });

    const pending = recent.filter((signal: any) => {
      const status = String(signal?.status || "").toUpperCase();
      return status === "PENDING" || status === "SCORING";
    });

    const scored = recent.filter((signal: any) => String(signal?.status || "").toUpperCase() === "SCORED");

    const zeroScoreCount = scored.filter((signal: any) => {
      const score = typeof signal?.aiScore === "number" ? signal.aiScore : null;
      const grade = String(signal?.aiGrade || signal?.grade || "").toUpperCase();
      return (score !== null && score <= 0) || grade === "F";
    }).length;

    const latestScoredTs = scored
      .map((signal: any) => {
        const updatedAt = toTimestamp(signal?.updatedAt);
        const createdAt = toTimestamp(signal?.createdAt);
        if (Number.isFinite(updatedAt)) return updatedAt;
        if (Number.isFinite(createdAt)) return createdAt;
        return Number.NaN;
      })
      .filter((ts: number) => Number.isFinite(ts))
      .sort((a: number, b: number) => b - a)[0];

    return {
      pendingCount: pending.length,
      scoredCount: scored.length,
      zeroScoreCount,
      latestScoredAt: Number.isFinite(latestScoredTs) ? new Date(latestScoredTs).toISOString() : null,
    };
  });
}

export async function readAgentTelemetrySnapshot(): Promise<AgentTelemetrySnapshot> {
  const now = new Date();
  const etDate = getEtDateString(now);
  const nowIso = now.toISOString();

  const [clock, funnel, signalSummary, guardState, toggleState, brokerTruth, trades] = await Promise.all([
    fetchAlpacaClock().catch(() => null),
    readTodayFunnel().catch(() => null),
    summarizeSignals().catch(
      () =>
        ({ pendingCount: 0, scoredCount: 0, zeroScoreCount: 0, latestScoredAt: null }) as TelemetrySignalsSnapshot
    ),
    getGuardrailsState(etDate).catch(() => null),
    getAutoEntryEnabledState(getGuardrailConfig()).catch(() => ({ enabled: true, reason: null })),
    fetchBrokerTruth().catch(() => null),
    readTrades().catch(() => []),
  ]);

  const marketOpen = clock ? Boolean(clock.is_open) : null;
  const scannerAgeMinutes = minutesSince(funnel?.lastScanAt ?? null);
  const scoreAgeMinutes = minutesSince(signalSummary.latestScoredAt ?? null);

  const staleScanner = marketOpen === true && (scannerAgeMinutes == null || scannerAgeMinutes > STALE_SCANNER_MINUTES);
  const staleScoring =
    marketOpen === true &&
    signalSummary.pendingCount > 0 &&
    (scoreAgeMinutes == null || scoreAgeMinutes > STALE_SCORING_MINUTES);

  const autoEntryDisabled = !toggleState.enabled || Boolean(guardState?.autoDisabledReason);
  const autoEntryDisableReason =
    guardState?.autoDisabledReason ?? (toggleState.enabled ? null : toggleState.reason ?? "auto entry disabled");

  const brokerPositionsCount =
    typeof brokerTruth?.positionsCount === "number"
      ? brokerTruth.positionsCount
      : Array.isArray(brokerTruth?.positions)
        ? brokerTruth.positions.length
        : 0;

  const dbOperationalOpenCount = countOperationalOpenTickers(Array.isArray(trades) ? trades : []);
  const openTradeMismatch = brokerTruth?.error ? false : brokerPositionsCount !== dbOperationalOpenCount;

  const readinessReasons: string[] = [];
  if (staleScanner) readinessReasons.push("scanner stale during market hours");
  if (staleScoring) readinessReasons.push("scoring stale while pending signals exist");
  if (autoEntryDisabled) readinessReasons.push(`auto-entry disabled${autoEntryDisableReason ? `: ${autoEntryDisableReason}` : ""}`);
  if (openTradeMismatch) {
    readinessReasons.push(
      `open-trade mismatch broker=${brokerPositionsCount} db=${dbOperationalOpenCount}`
    );
  }

  return {
    nowIso,
    etDate,
    marketOpen,
    readinessReady: readinessReasons.length === 0,
    readinessReasons,
    staleScoring,
    staleScanner,
    autoEntryDisabled,
    autoEntryDisableReason,
    openTradeMismatch,
    brokerPositionsCount,
    dbOperationalOpenCount,
    signalsPendingCount: signalSummary.pendingCount,
    signalsScoredCount: signalSummary.scoredCount,
    zeroScoreCount: signalSummary.zeroScoreCount,
  };
}