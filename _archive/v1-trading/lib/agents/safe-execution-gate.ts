/**
 * Safe Execution Gate — validates a self-heal task execution result
 * before it can be marked as resolved.
 *
 * Contract:
 *   1. Local build probe must pass (ping /api/agents/state)
 *   2. Targeted smoke probes must pass (readiness + protection-audit)
 *   3. On failure, task remains unresolved with remediation metadata
 *
 * Auth: forwards x-cron-token and x-vercel-protection-bypass headers
 * so probes succeed both through Vercel Deployment Protection and
 * through route-level auth.
 */

import type { CriticalTask } from "@/lib/redis";

// ─── Types ──────────────────────────────────────────────────────────

export interface ProbeResult {
  route: string;
  ok: boolean;
  status: number | null;
  reason: string | null;
}

export interface GateResult {
  passed: boolean;
  buildOk: boolean;
  buildProbe: ProbeResult;
  smokeOk: boolean;
  smokeProbes: ProbeResult[];
  validatedAt: string;
  failureReason: string | null;
  baseUrl: string;
  authMode: string;
}

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Resolve the base URL for internal self-probes.
 * Prefer explicit production URL over VERCEL_URL which may be a
 * deployment-specific URL behind Vercel Deployment Protection.
 */
function resolveBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/+$/, "");
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function buildProbeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
  };
  const cronToken = process.env.CRON_TOKEN ?? process.env.CRON_SECRET ?? "";
  if (cronToken) headers["x-cron-token"] = cronToken;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
  if (bypassSecret) headers["x-vercel-protection-bypass"] = bypassSecret;
  return headers;
}

function authModeLabel(): string {
  if (process.env.CRON_TOKEN || process.env.CRON_SECRET) return "cron_token";
  return "none";
}

const SMOKE_ROUTES_FOR_INCIDENT: Record<string, string[]> = {
  MISSING_STOP: ["/api/readiness", "/api/trades/protection-audit"],
  STOP_EXPIRED: ["/api/readiness", "/api/trades/protection-audit"],
  STOP_CANCELED: ["/api/readiness", "/api/trades/protection-audit"],
  STOP_DAY_TIF: ["/api/readiness", "/api/trades/protection-audit"],
  STOP_REPAIR_FAILED: ["/api/readiness", "/api/trades/protection-audit"],
  FLATTEN_FAILED: ["/api/readiness", "/api/trades/protection-audit"],
  BROKER_DB_MISMATCH: ["/api/readiness", "/api/trades/protection-audit"],
};

const DEFAULT_SMOKE_ROUTES = ["/api/readiness", "/api/trades/protection-audit"];

// ─── Probe runner ───────────────────────────────────────────────────

async function probeRoute(
  base: string,
  route: string,
  headers: Record<string, string>,
): Promise<ProbeResult> {
  try {
    const res = await fetch(`${base}${route}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    return {
      route,
      ok: res.ok,
      status: res.status,
      reason: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      route,
      ok: false,
      status: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Gate runner ────────────────────────────────────────────────────

export async function runSafeExecutionGate(
  task: CriticalTask,
): Promise<GateResult> {
  const now = new Date().toISOString();
  const base = resolveBaseUrl();
  const headers = buildProbeHeaders();
  const authMode = authModeLabel();

  // 1. Build probe — confirm runtime is operational
  const buildProbe = await probeRoute(base, "/api/agents/state", headers);

  // 2. Targeted smoke probes for this incident type
  const smokeRoutes =
    SMOKE_ROUTES_FOR_INCIDENT[task.incidentCode] ?? DEFAULT_SMOKE_ROUTES;
  const smokeProbes: ProbeResult[] = [];
  for (const route of smokeRoutes) {
    smokeProbes.push(await probeRoute(base, route, headers));
  }
  const smokeOk = smokeProbes.every((p) => p.ok);

  const passed = buildProbe.ok && smokeOk;
  const reasons: string[] = [];
  if (!buildProbe.ok) reasons.push(`build(${buildProbe.route}): ${buildProbe.reason}`);
  for (const p of smokeProbes) {
    if (!p.ok) reasons.push(`smoke(${p.route}): ${p.reason}`);
  }

  return {
    passed,
    buildOk: buildProbe.ok,
    buildProbe,
    smokeOk,
    smokeProbes,
    validatedAt: now,
    failureReason: passed ? null : reasons.join("; "),
    baseUrl: base,
    authMode,
  };
}
