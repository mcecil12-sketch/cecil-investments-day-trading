/**
 * Incident Resolution — manages lifecycle of critical incident tasks.
 *
 * Uses existing Redis critical task storage. Adds:
 *   - Verified resolution (only resolves after post-fix verification passes)
 *   - Attempt metadata (lastAttemptAt, lastAttemptResult, lastVerificationResult)
 *   - Post-fix verification via protection-audit / readiness re-check
 */

import { redis, getCriticalTasks, type CriticalTask } from "@/lib/redis";

const CRITICAL_TASKS_KEY = "critical_tasks";

// ─── Types ──────────────────────────────────────────────────────────

export interface AttemptMetadata {
  lastAttemptAt: string;
  lastAttemptResult: "success" | "failure";
  lastVerificationResult: "passed" | "failed" | "skipped";
  lastVerificationReason?: string;
}

export interface VerificationResult {
  passed: boolean;
  source: string;
  reason: string | null;
  checkedAt: string;
}

// ─── Attempt metadata ───────────────────────────────────────────────

const ATTEMPT_META_PREFIX = "critical_task_meta:";

export async function setAttemptMetadata(
  taskId: string,
  meta: AttemptMetadata,
): Promise<boolean> {
  if (!redis) return false;
  await redis.set(`${ATTEMPT_META_PREFIX}${taskId}`, meta, { ex: 86400 * 7 });
  return true;
}

export async function getAttemptMetadata(
  taskId: string,
): Promise<AttemptMetadata | null> {
  if (!redis) return null;
  return redis.get<AttemptMetadata>(`${ATTEMPT_META_PREFIX}${taskId}`);
}

// ─── Post-fix verification ──────────────────────────────────────────

/**
 * Re-check protection-audit and/or readiness to verify the incident is
 * actually resolved. Calls the internal API routes.
 */
export async function runPostFixVerification(
  task: CriticalTask,
): Promise<VerificationResult> {
  const now = new Date().toISOString();
  // Prefer NEXT_PUBLIC_BASE_URL (project convention for trusted production URL)
  const base = (
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/+$/, "") ||
    process.env.APP_URL?.replace(/\/+$/, "") ||
    process.env.NEXTAUTH_URL?.replace(/\/+$/, "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    "http://localhost:3000"
  );
  const cronToken = process.env.CRON_TOKEN ?? process.env.CRON_SECRET ?? "";
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";

  const headers: Record<string, string> = {
    "cache-control": "no-store",
  };
  if (cronToken) headers["x-cron-token"] = cronToken;
  if (bypassSecret) headers["x-vercel-protection-bypass"] = bypassSecret;

  // 1. Check protection-audit
  try {
    const auditResp = await fetch(`${base}/api/trades/protection-audit`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!auditResp.ok) {
      return {
        passed: false,
        source: "protection-audit",
        reason: `protection-audit returned HTTP ${auditResp.status}`,
        checkedAt: now,
      };
    }

    const auditBody = await auditResp.json();
    // Check if the specific symbol still has critical incidents
    const remainingCritical = (auditBody?.incidents ?? []).filter(
      (i: any) =>
        i.severity === "CRITICAL" &&
        (i.symbol === task.symbol || !task.symbol),
    );

    if (remainingCritical.length > 0) {
      return {
        passed: false,
        source: "protection-audit",
        reason: `${remainingCritical.length} critical incident(s) still present for ${task.symbol}: ${remainingCritical.map((i: any) => i.code).join(", ")}`,
        checkedAt: now,
      };
    }
  } catch (err) {
    // Network error — fail-open in serverless but note it
    return {
      passed: false,
      source: "protection-audit",
      reason: `verification fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      checkedAt: now,
    };
  }

  // 2. Check readiness
  try {
    const readinessResp = await fetch(`${base}/api/readiness`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (readinessResp.ok) {
      const body = await readinessResp.json();
      const protectionCheck = (body?.checks ?? []).find(
        (c: any) => c.name === "protection_integrity",
      );
      if (protectionCheck && !protectionCheck.ok) {
        return {
          passed: false,
          source: "readiness",
          reason: `readiness protection_integrity check failed: ${protectionCheck.detail || "unknown"}`,
          checkedAt: now,
        };
      }
    }
    // readiness failure is non-fatal for resolution verification
  } catch {
    // readiness network failure is non-fatal
  }

  return {
    passed: true,
    source: "protection-audit+readiness",
    reason: null,
    checkedAt: now,
  };
}

// ─── Verified resolution ────────────────────────────────────────────

/**
 * Mark a critical task resolved ONLY after post-fix verification passes.
 * Returns whether the task was actually resolved.
 */
export async function resolveWithVerification(
  taskId: string,
): Promise<{
  resolved: boolean;
  verification: VerificationResult;
  task: CriticalTask | null;
}> {
  if (!redis) {
    return {
      resolved: false,
      verification: {
        passed: false,
        source: "redis",
        reason: "redis_unavailable",
        checkedAt: new Date().toISOString(),
      },
      task: null,
    };
  }

  const task = await redis.hget<CriticalTask>(CRITICAL_TASKS_KEY, taskId);
  if (!task) {
    return {
      resolved: false,
      verification: {
        passed: false,
        source: "redis",
        reason: "task_not_found",
        checkedAt: new Date().toISOString(),
      },
      task: null,
    };
  }

  // Synthetic drills — auto-resolve without broker verification
  if (task.synthetic) {
    task.resolvedAt = new Date().toISOString();
    await redis.hset(CRITICAL_TASKS_KEY, { [taskId]: task });
    const syntheticMeta: AttemptMetadata = {
      lastAttemptAt: task.resolvedAt,
      lastAttemptResult: "success",
      lastVerificationResult: "skipped",
      lastVerificationReason: "synthetic_drill",
    };
    await setAttemptMetadata(taskId, syntheticMeta);
    return {
      resolved: true,
      verification: {
        passed: true,
        source: "synthetic",
        reason: "synthetic_drill_auto_resolved",
        checkedAt: task.resolvedAt,
      },
      task,
    };
  }

  // Run post-fix verification
  const verification = await runPostFixVerification(task);

  const now = new Date().toISOString();
  const attemptMeta: AttemptMetadata = {
    lastAttemptAt: now,
    lastAttemptResult: verification.passed ? "success" : "failure",
    lastVerificationResult: verification.passed ? "passed" : "failed",
    lastVerificationReason: verification.reason ?? undefined,
  };
  await setAttemptMetadata(taskId, attemptMeta);

  if (!verification.passed) {
    // Leave task unresolved
    return { resolved: false, verification, task };
  }

  // Mark resolved
  task.resolvedAt = now;
  await redis.hset(CRITICAL_TASKS_KEY, { [taskId]: task });

  return { resolved: true, verification, task };
}
