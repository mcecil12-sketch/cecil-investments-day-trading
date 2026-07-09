/**
 * Issue Registry — Structured Execution Control
 *
 * Prevents duplicate agent patches for the same issue within a 30-minute
 * window. Each issue has a single owner and cannot be re-attempted without
 * either explicit resolution (resolveIssue) or rate-limit expiry.
 *
 * Redis keys — individual strings per issueKey with TTL-encoded lifecycle:
 *   agents:issue:v1:{issueKey}
 *
 * TTL governs lifecycle:
 *   IN_PROGRESS  → 2-hour auto-expiry (stale lock protection)
 *   RESOLVED     → 30-min auto-expiry (= cooldown window; key expiry = cooldown end)
 *   OPEN         → 1-hour auto-expiry (cleanup for failed/unresolved attempts)
 *
 * Gate logic in checkIssue:
 *   1. COOLDOWN     — RESOLVED record still exists within 30-min TTL
 *   2. WRONG_OWNER  — IN_PROGRESS owned by a different agent
 *   3. RATE_LIMITED — OPEN with >= 2 attempts in the last 30 minutes
 *
 * Intended call sequence:
 *   1. checkIssue(key, owner)                  — gate check
 *   2. [if PROCEED] do work / create task
 *   3. claimIssue(key, owner)                  — register ownership
 *   4. [after verification] resolveIssue OR failAttempt
 */

import { redis } from "@/lib/redis";

// ─── Constants ────────────────────────────────────────────────────────────────

export const COOLDOWN_MS = 30 * 60 * 1000;           // 30 minutes
export const RATE_LIMIT_ATTEMPTS = 2;
export const RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000;  // 30 minutes

// TTLs (seconds) — encode lifecycle directly into key expiry
const IN_PROGRESS_TTL_SEC = 2 * 60 * 60;  // 2 hours — stale lock protection
const RESOLVED_TTL_SEC    = 30 * 60;       // 30 min  — == cooldown window
const OPEN_TTL_SEC        = 60 * 60;       // 1 hour  — general cleanup

const KEY_PREFIX = "agents:issue:v1:";

// ─── Types ───────────────────────────────────────────────────────────────────

export type IssueStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED";

export interface IssueRecord {
  issueKey:       string;
  status:         IssueStatus;
  owner:          string;
  createdAt:      number;      // unix ms
  lastAttemptAt:  number;      // unix ms
  resolvedAt?:    number;      // unix ms — set when status = RESOLVED
  attempts:       number;      // attempts within the current rate-limit window
}

export type SkipReason = "IN_PROGRESS" | "WRONG_OWNER" | "RATE_LIMITED" | "COOLDOWN";

export type IssueCheckResult =
  | { action: "PROCEED"; record: IssueRecord | null }
  | { action: "SKIP"; reason: SkipReason; record: IssueRecord };

// ─── Internal helpers ────────────────────────────────────────────────────────

function redisKey(issueKey: string): string {
  return KEY_PREFIX + issueKey;
}

async function readRecord(issueKey: string): Promise<IssueRecord | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get<IssueRecord | string>(redisKey(issueKey));
    if (!raw) return null;
    return typeof raw === "string" ? (JSON.parse(raw) as IssueRecord) : (raw as IssueRecord);
  } catch {
    return null;
  }
}

async function writeRecord(record: IssueRecord, ttlSec: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(redisKey(record.issueKey), JSON.stringify(record), { ex: ttlSec });
  } catch {
    // non-fatal
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Read the current registry record for an issue without mutation.
 */
export async function readIssueRecord(issueKey: string): Promise<IssueRecord | null> {
  return readRecord(issueKey);
}

/**
 * Check whether an agent should proceed creating/patching for this issue.
 *
 * Returns { action: "SKIP", reason } when any gate applies, or
 * { action: "PROCEED" } when all gates pass.
 *
 * No state is mutated — always call claimIssue after a PROCEED decision.
 */
export async function checkIssue(issueKey: string, owner: string): Promise<IssueCheckResult> {
  const record = await readRecord(issueKey);

  // No record — first time seeing this issue, safe to proceed
  if (!record) return { action: "PROCEED", record: null };

  const now = Date.now();

  switch (record.status) {
    case "RESOLVED":
      // Record still exists → within 30-min cooldown TTL window
      console.log(
        `[issue-registry] AGENT_COOLDOWN_SKIP issueKey=${issueKey} owner=${owner} resolvedAt=${
          record.resolvedAt ? new Date(record.resolvedAt).toISOString() : "unknown"
        }`,
      );
      return { action: "SKIP", reason: "COOLDOWN", record };

    case "IN_PROGRESS":
      if (record.owner !== owner) {
        console.log(
          `[issue-registry] AGENT_SKIP_DUPLICATE issueKey=${issueKey} requestor=${owner} ` +
          `owner=${record.owner} reason=IN_PROGRESS`,
        );
        return { action: "SKIP", reason: "WRONG_OWNER", record };
      }
      // Same owner re-checking mid-execution: allow
      return { action: "PROCEED", record };

    case "OPEN":
      // Rate-limit: too many attempts within the current 30-min window
      if (
        record.attempts >= RATE_LIMIT_ATTEMPTS &&
        now - record.lastAttemptAt < RATE_LIMIT_WINDOW_MS
      ) {
        console.log(
          `[issue-registry] AGENT_SKIP_DUPLICATE issueKey=${issueKey} owner=${owner} ` +
          `reason=RATE_LIMITED attempts=${record.attempts}`,
        );
        return { action: "SKIP", reason: "RATE_LIMITED", record };
      }
      return { action: "PROCEED", record };

    default:
      return { action: "PROCEED", record };
  }
}

/**
 * Claim ownership of an issue: status → IN_PROGRESS.
 *
 * Returns false if a different agent already holds an IN_PROGRESS lock.
 * Increments attempt count within the current 30-min rate-limit window;
 * resets to 1 when the window has expired.
 */
export async function claimIssue(issueKey: string, owner: string): Promise<boolean> {
  const now = Date.now();
  const existing = await readRecord(issueKey);

  // Reject if a different agent is already working on this issue
  if (existing?.status === "IN_PROGRESS" && existing.owner !== owner) {
    console.log(
      `[issue-registry] CLAIM_REJECTED issueKey=${issueKey} requestor=${owner} ` +
      `existingOwner=${existing.owner}`,
    );
    return false;
  }

  // Roll attempt counter: reset window if previous attempt was > 30 min ago
  const attemptsInWindow =
    existing && now - existing.lastAttemptAt < RATE_LIMIT_WINDOW_MS
      ? existing.attempts + 1
      : 1;

  const record: IssueRecord = {
    issueKey,
    status:        "IN_PROGRESS",
    owner,
    createdAt:     existing?.createdAt ?? now,
    lastAttemptAt: now,
    resolvedAt:    undefined,
    attempts:      attemptsInWindow,
  };

  await writeRecord(record, IN_PROGRESS_TTL_SEC);
  console.log(
    `[issue-registry] AGENT_CLAIM issueKey=${issueKey} owner=${owner} attempts=${record.attempts}`,
  );
  return true;
}

/**
 * Resolve an issue after successful verification.
 *
 * Writes a RESOLVED record with RESOLVED_TTL_SEC (30 min) TTL — while the
 * record exists, checkIssue returns SKIP:COOLDOWN for the same key.
 * Once the TTL expires, the cooldown has passed and re-evaluation is allowed.
 *
 * No-op if no record exists (issue was never claimed — nothing to resolve).
 */
export async function resolveIssue(issueKey: string, owner: string): Promise<void> {
  const now = Date.now();
  const existing = await readRecord(issueKey);

  // Nothing to resolve — issue was never claimed
  if (!existing) return;

  // Only the owning agent (or the same agent on an OPEN record) can resolve
  if (existing.status === "IN_PROGRESS" && existing.owner !== owner) {
    console.warn(
      `[issue-registry] RESOLVE_REJECTED issueKey=${issueKey} requestor=${owner} ` +
      `owner=${existing.owner}`,
    );
    return;
  }

  const record: IssueRecord = {
    ...existing,
    status:        "RESOLVED",
    owner,
    lastAttemptAt: now,
    resolvedAt:    now,
  };

  await writeRecord(record, RESOLVED_TTL_SEC);
  console.log(`[issue-registry] AGENT_RESOLVE issueKey=${issueKey} owner=${owner}`);
}

/**
 * Record a failed verification attempt. Sets status → OPEN and increments
 * the attempt counter within the current window. After RATE_LIMIT_ATTEMPTS
 * failures, checkIssue will return SKIP:RATE_LIMITED until the window clears.
 */
export async function failAttempt(issueKey: string, owner: string): Promise<void> {
  const now = Date.now();
  const existing = await readRecord(issueKey);

  const attemptsInWindow =
    existing && now - existing.lastAttemptAt < RATE_LIMIT_WINDOW_MS
      ? existing.attempts + 1
      : 1;

  const record: IssueRecord = {
    ...(existing ?? { createdAt: now }),
    issueKey,
    status:        "OPEN",
    owner,
    lastAttemptAt: now,
    resolvedAt:    undefined,
    attempts:      attemptsInWindow,
  };

  await writeRecord(record, OPEN_TTL_SEC);
  console.log(
    `[issue-registry] FAIL_ATTEMPT issueKey=${issueKey} owner=${owner} attempts=${record.attempts}`,
  );
}
