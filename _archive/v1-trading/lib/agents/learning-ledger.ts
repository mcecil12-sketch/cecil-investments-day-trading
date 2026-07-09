/**
 * Learning Action Ledger — Phase 5
 *
 * Persistent, append-only log of all learning-driven findings,
 * remediations, verifications, and rollbacks. Stored in Redis
 * as a bounded list.
 *
 * Surfaced in:
 *   - /api/agents/state  (summary)
 *   - /api/agents/brief  (actionable section)
 */

import { redis } from "@/lib/redis";

// ─── Key ────────────────────────────────────────────────────────────

export const AGENT_LEARNING_LEDGER_KEY = "agents:learning_ledger:v1";

// ─── Types ──────────────────────────────────────────────────────────

export type LedgerEntryType =
  | "finding_detected"
  | "remediation_applied"
  | "remediation_verified"
  | "remediation_rolled_back"
  | "informational";

export interface LedgerEntry {
  id: string;
  type: LedgerEntryType;
  timestamp: string;
  findingId?: string;
  findingCategory?: string;
  findingSeverity?: string;
  actionId?: string;
  actionType?: string;
  appliedValue?: number | string | boolean;
  previousValue?: number | string | boolean | null;
  reason?: string;
  verifyAfter?: string;
  verifiedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface LedgerSummary {
  totalEntries: number;
  recentEntries: LedgerEntry[];
  openRemediations: number;
  pendingVerifications: number;
  recentRollbacks: number;
  lastEntryAt: string | null;
}

// ─── Bounded list config ────────────────────────────────────────────

const MAX_LEDGER_ENTRIES = 200;
const LEDGER_TTL_SECONDS = 86400 * 14; // 14 days

// ─── Write ──────────────────────────────────────────────────────────

export async function recordLedgerEntry(
  input: Omit<LedgerEntry, "id" | "timestamp">,
): Promise<LedgerEntry> {
  const entry: LedgerEntry = {
    ...input,
    id: `${input.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };

  if (!redis) return entry;

  try {
    await redis.lpush(AGENT_LEARNING_LEDGER_KEY, JSON.stringify(entry));
    await redis.ltrim(AGENT_LEARNING_LEDGER_KEY, 0, MAX_LEDGER_ENTRIES - 1);
    await redis.expire(AGENT_LEARNING_LEDGER_KEY, LEDGER_TTL_SECONDS);
  } catch (err) {
    console.warn("[LEARNING-LEDGER] Failed to write ledger entry:", err);
  }

  return entry;
}

// ─── Read ───────────────────────────────────────────────────────────

export async function readRecentLedger(limit = 50): Promise<LedgerEntry[]> {
  if (!redis) return [];
  try {
    const raw = await redis.lrange(AGENT_LEARNING_LEDGER_KEY, 0, limit - 1);
    return raw
      .map((item: unknown) => {
        if (typeof item === "string") {
          try {
            return JSON.parse(item) as LedgerEntry;
          } catch {
            return null;
          }
        }
        return item as LedgerEntry;
      })
      .filter((e): e is LedgerEntry => e !== null);
  } catch {
    return [];
  }
}

// ─── Summary for API surfaces ───────────────────────────────────────

export async function getLedgerSummary(): Promise<LedgerSummary> {
  const recent = await readRecentLedger(100);
  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 3600_000;

  const recentEntries = recent.filter(
    (e) => Date.parse(e.timestamp) > twentyFourHoursAgo,
  );

  const openRemediations = recentEntries.filter(
    (e) =>
      e.type === "remediation_applied" &&
      !recentEntries.some(
        (v) =>
          (v.type === "remediation_verified" || v.type === "remediation_rolled_back") &&
          v.actionId === e.actionId,
      ),
  ).length;

  const pendingVerifications = recentEntries.filter(
    (e) =>
      e.type === "remediation_applied" &&
      e.verifyAfter &&
      Date.parse(e.verifyAfter) > now &&
      !recentEntries.some(
        (v) =>
          (v.type === "remediation_verified" || v.type === "remediation_rolled_back") &&
          v.actionId === e.actionId,
      ),
  ).length;

  const recentRollbacks = recentEntries.filter(
    (e) => e.type === "remediation_rolled_back",
  ).length;

  return {
    totalEntries: recent.length,
    recentEntries: recentEntries.slice(0, 20),
    openRemediations,
    pendingVerifications,
    recentRollbacks,
    lastEntryAt: recent.length > 0 ? recent[0].timestamp : null,
  };
}
