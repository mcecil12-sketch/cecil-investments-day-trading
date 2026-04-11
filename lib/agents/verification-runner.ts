/**
 * Verification Runner — Phase 4
 *
 * Structured verification for agent execution results.
 * Runs build probe, smoke probes, and task-specific checks.
 * Returns structured probe results, not a single boolean.
 */

import type { EngineeringTask, StructuredVerificationResult } from "@/lib/agents/types";

// ─── Internal helpers ───────────────────────────────────────────────

function resolveBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/+$/, "");
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function buildProbeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  const cronToken = process.env.CRON_TOKEN ?? process.env.CRON_SECRET ?? "";
  if (cronToken) headers["x-cron-token"] = cronToken;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
  if (bypassSecret) headers["x-vercel-protection-bypass"] = bypassSecret;
  return headers;
}

interface ProbeResult {
  route: string;
  ok: boolean;
  status: number | null;
  reason: string | null;
}

async function probeRoute(base: string, route: string, headers: Record<string, string>): Promise<ProbeResult> {
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

// ─── Default smoke routes ───────────────────────────────────────────

const DEFAULT_SMOKE_ROUTES = ["/api/readiness", "/api/trades/protection-audit"];

function getTaskSmokeRoutes(task: EngineeringTask): string[] {
  const routes: string[] = [];
  if (task.validationPlan?.smokeChecks) {
    for (const check of task.validationPlan.smokeChecks) {
      const trimmed = check.trim();
      if (trimmed.startsWith("/api/")) {
        routes.push(trimmed);
      } else if (trimmed.startsWith("GET ") || trimmed.startsWith("POST ")) {
        const path = trimmed.replace(/^(GET|POST)\s+/, "").trim();
        if (path.startsWith("/api/")) routes.push(path);
      }
    }
  }
  if (task.smokeTestBlock) {
    for (const line of task.smokeTestBlock.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("/api/")) {
        routes.push(trimmed);
      } else if (trimmed.startsWith("GET ") || trimmed.startsWith("POST ")) {
        const path = trimmed.replace(/^(GET|POST)\s+/, "").trim();
        if (path.startsWith("/api/")) routes.push(path);
      }
    }
  }
  return [...new Set(routes)];
}

// ─── Main Runner ────────────────────────────────────────────────────

export async function runStructuredVerification(
  task: EngineeringTask,
): Promise<StructuredVerificationResult> {
  const base = resolveBaseUrl();
  const headers = buildProbeHeaders();
  const now = new Date().toISOString();

  console.log(`[VERIFY] Starting verification for task ${task.id}`);

  // 1. Build probe — confirm runtime is operational
  const buildProbe = await probeRoute(base, "/api/agents/state", headers);
  console.log(`[VERIFY] Build probe: ${buildProbe.ok ? "PASS" : "FAIL"} (${buildProbe.route})`);

  // 2. Default smoke probes
  const smokeProbes: ProbeResult[] = [];
  for (const route of DEFAULT_SMOKE_ROUTES) {
    const result = await probeRoute(base, route, headers);
    smokeProbes.push(result);
    console.log(`[VERIFY] Smoke probe: ${result.ok ? "PASS" : "FAIL"} (${result.route})`);
  }

  // 3. Task-specific probes
  const taskRoutes = getTaskSmokeRoutes(task);
  const taskResults: Array<{ target: string; ok: boolean; detail: string | null }> = [];
  for (const route of taskRoutes) {
    if (DEFAULT_SMOKE_ROUTES.includes(route)) continue; // already probed
    const result = await probeRoute(base, route, headers);
    taskResults.push({
      target: route,
      ok: result.ok,
      detail: result.reason,
    });
    console.log(`[VERIFY] Task probe: ${result.ok ? "PASS" : "FAIL"} (${result.route})`);
  }

  const buildOk = buildProbe.ok;
  const smokeOk = smokeProbes.every((p) => p.ok);
  const taskOk = taskResults.every((r) => r.ok);
  const overall = buildOk && smokeOk && taskOk;

  const failureReasons: string[] = [];
  if (!buildOk) failureReasons.push(`build(${buildProbe.route}): ${buildProbe.reason}`);
  for (const p of smokeProbes) {
    if (!p.ok) failureReasons.push(`smoke(${p.route}): ${p.reason}`);
  }
  for (const r of taskResults) {
    if (!r.ok) failureReasons.push(`task(${r.target}): ${r.detail}`);
  }

  console.log(`[VERIFY] Overall: ${overall ? "PASS" : "FAIL"}${failureReasons.length ? ` — ${failureReasons.join("; ")}` : ""}`);

  return {
    gateResult: {
      passed: overall,
      buildOk,
      smokeOk: smokeOk && taskOk,
      failureReason: overall ? null : failureReasons.join("; "),
    },
    probeResults: [buildProbe, ...smokeProbes],
    taskSpecificResults: taskResults,
    overall,
    verifiedAt: now,
  };
}
