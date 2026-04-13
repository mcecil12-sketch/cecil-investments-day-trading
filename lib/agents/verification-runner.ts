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
  method?: string;
}

async function probeRoute(
  base: string,
  route: string,
  headers: Record<string, string>,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
): Promise<ProbeResult> {
  try {
    const fetchOptions: RequestInit = {
      method,
      headers: {
        ...headers,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    };
    if (method === "POST" && body) {
      fetchOptions.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${route}`, fetchOptions);
    return {
      route,
      ok: res.ok,
      status: res.status,
      reason: res.ok ? null : `HTTP ${res.status}`,
      method,
    };
  } catch (err) {
    return {
      route,
      ok: false,
      status: null,
      reason: err instanceof Error ? err.message : String(err),
      method,
    };
  }
}

// ─── Default smoke routes ───────────────────────────────────────────

const DEFAULT_SMOKE_ROUTES = ["/api/readiness", "/api/trades/protection-audit"];

function getTaskSmokeRoutes(task: EngineeringTask): Array<{ route: string; method: "GET" | "POST" }> {
  const routes: Array<{ route: string; method: "GET" | "POST" }> = [];
  const seen = new Set<string>();

  function addRoute(route: string, method: "GET" | "POST" = "GET") {
    if (EXCLUDED_PROBE_ROUTES.has(route)) return; // never probe self-referential routes
    const key = `${method}:${route}`;
    if (!seen.has(key)) {
      seen.add(key);
      routes.push({ route, method });
    }
  }

  if (task.validationPlan?.smokeChecks) {
    for (const check of task.validationPlan.smokeChecks) {
      const trimmed = check.trim();
      if (trimmed.startsWith("/api/")) {
        addRoute(trimmed, "GET");
      } else if (trimmed.startsWith("GET ") || trimmed.startsWith("POST ")) {
        const method = trimmed.startsWith("POST ") ? "POST" : "GET";
        const path = trimmed.replace(/^(GET|POST)\s+/, "").trim();
        if (path.startsWith("/api/")) addRoute(path, method);
      }
    }
  }
  if (task.smokeTestBlock) {
    for (const line of task.smokeTestBlock.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("/api/")) {
        addRoute(trimmed, "GET");
      } else if (trimmed.startsWith("GET ") || trimmed.startsWith("POST ")) {
        const method = trimmed.startsWith("POST ") ? "POST" : "GET";
        const path = trimmed.replace(/^(GET|POST)\s+/, "").trim();
        if (path.startsWith("/api/")) addRoute(path, method);
      }
    }
  }
  return routes;
}

// ─── Task-type-specific verification strategies ─────────────────────

/** Known route→method mapping for routes that don't accept GET. */
const KNOWN_POST_ROUTES: Record<string, { method: "POST"; body?: Record<string, unknown> }> = {
  "/api/ai/score/drain": { method: "POST", body: { budgetMs: 5000, limit: 1 } },
  "/api/agents/chat-intake": { method: "POST" },
  "/api/agents/chat-command": { method: "POST" },
  "/api/agents/intake": { method: "POST" },
  "/api/agents/execute": { method: "POST" },
};

/** Routes that must NEVER be probed during verification (self-referential or trigger side-effects). */
const EXCLUDED_PROBE_ROUTES = new Set([
  "/api/agents/execute",
  "/api/agents/intake",
  "/api/agents/chat-intake",
  "/api/agents/chat-command",
]);

/** Returns task-type-specific verification probes based on the task's characteristics. */
function getTaskTypeVerificationProbes(task: EngineeringTask): Array<{
  route: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  label: string;
}> {
  // Detect SCORING tasks by title, taskType hint, or route hints
  const isScoringTask =
    task.title?.toLowerCase().includes("scoring") ||
    task.title?.toLowerCase().includes("score") ||
    task.title?.toLowerCase().includes("drain") ||
    (task.validationPlan?.smokeChecks ?? []).some((c) => c.includes("/api/ai/score/drain"));

  if (isScoringTask) {
    return [
      { route: "/api/ai/score/drain", method: "POST", body: { budgetMs: 5000, limit: 1 }, label: "scoring_drain_reachable" },
      { route: "/api/signals/all", method: "GET", label: "signals_all_reachable" },
      { route: "/api/readiness", method: "GET", label: "readiness_reachable" },
    ];
  }

  return [];
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

  // 3. Task-specific probes (from smokeChecks / smokeTestBlock with correct methods)
  const taskRoutes = getTaskSmokeRoutes(task);
  const taskResults: Array<{ target: string; ok: boolean; detail: string | null; method?: string }> = [];
  for (const { route, method } of taskRoutes) {
    if (DEFAULT_SMOKE_ROUTES.includes(route) && method === "GET") continue; // already probed
    // Check known POST routes override
    const knownOverride = KNOWN_POST_ROUTES[route];
    const probeMethod = knownOverride?.method ?? method;
    const probeBody = knownOverride?.body;
    const result = await probeRoute(base, route, headers, probeMethod, probeBody);
    taskResults.push({
      target: route,
      ok: result.ok,
      detail: result.reason,
      method: probeMethod,
    });
    console.log(`[VERIFY] Task probe: ${result.ok ? "PASS" : "FAIL"} (${probeMethod} ${result.route})`);
  }

  // 4. Task-type-specific verification probes (scoring, scanner, etc.)
  const typeProbes = getTaskTypeVerificationProbes(task);
  for (const { route, method, body, label } of typeProbes) {
    // Skip if already probed in task-specific or default probes
    const alreadyProbed = taskResults.some((r) => r.target === route) ||
      (DEFAULT_SMOKE_ROUTES.includes(route) && method === "GET");
    if (alreadyProbed) continue;
    const result = await probeRoute(base, route, headers, method, body);
    taskResults.push({
      target: route,
      ok: result.ok,
      detail: result.ok ? null : `${label}: ${result.reason}`,
      method,
    });
    console.log(`[VERIFY] Type probe: ${result.ok ? "PASS" : "FAIL"} (${method} ${result.route} [${label}])`);
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
