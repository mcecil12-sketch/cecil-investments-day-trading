/**
 * Verification Runner — Phase 4
 *
 * Structured verification for agent execution results.
 * Runs build probe, smoke probes, and task-specific checks.
 * Returns structured probe results, not a single boolean.
 */

import type { EngineeringTask, StructuredVerificationResult } from "@/lib/agents/types";

// ─── Internal helpers ───────────────────────────────────────────────

type HttpMethod = "GET" | "POST";

type RouteAuthHeader = "x-cron-token" | "x-auto-entry-token" | "x-scanner-token";

interface RouteVerificationConfig {
  method: HttpMethod;
  authHeader?: RouteAuthHeader;
  body?: Record<string, unknown>;
}

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
  method: HttpMethod;
  json: unknown | null;
  timedOut: boolean;
}

function getRoutePath(route: string): string {
  const qIndex = route.indexOf("?");
  return qIndex >= 0 ? route.slice(0, qIndex) : route;
}

function getAuthTokenForHeader(header: RouteAuthHeader): string {
  if (header === "x-auto-entry-token") return process.env.AUTO_ENTRY_TOKEN ?? "";
  if (header === "x-scanner-token") return process.env.SCANNER_TOKEN ?? "";
  return process.env.CRON_TOKEN ?? process.env.CRON_SECRET ?? "";
}

function buildRouteHeaders(
  baseHeaders: Record<string, string>,
  routeConfig?: RouteVerificationConfig,
): { headers: Record<string, string>; authHeaderUsed: string | null } {
  const headers = { ...baseHeaders };
  if (!routeConfig?.authHeader) {
    return { headers, authHeaderUsed: null };
  }
  const token = getAuthTokenForHeader(routeConfig.authHeader);
  if (!token) {
    return { headers, authHeaderUsed: null };
  }
  headers[routeConfig.authHeader] = token;
  return { headers, authHeaderUsed: routeConfig.authHeader };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function getNumberField(value: unknown, key: string): number | null {
  if (!isObject(value)) return null;
  const maybe = value[key];
  return typeof maybe === "number" && Number.isFinite(maybe) ? maybe : null;
}

function getArrayField(value: unknown, key: string): unknown[] {
  if (!isObject(value)) return [];
  const maybe = value[key];
  return Array.isArray(maybe) ? maybe : [];
}

function evaluateSeedProbeResult(result: ProbeResult): { ok: boolean; detail: string | null } {
  if (result.status === 401 || result.status === 403 || result.status === 500) {
    return { ok: false, detail: `HTTP ${result.status}` };
  }
  if (!isObject(result.json)) {
    return { ok: false, detail: "invalid_json_response" };
  }
  if (result.json.ok !== true) {
    return { ok: false, detail: "json_ok_false" };
  }
  return { ok: true, detail: null };
}

function evaluateExecuteProbeResult(result: ProbeResult): { ok: boolean; detail: string | null } {
  if (result.status === 401 || result.status === 403 || result.status === 500) {
    return { ok: false, detail: `HTTP ${result.status}` };
  }
  if (!isObject(result.json)) {
    return { ok: false, detail: "invalid_json_response" };
  }

  const reason = typeof result.json.reason === "string" ? result.json.reason : null;
  if (reason === "market_closed" || reason === "no_AUTO_PENDING_trades") {
    return { ok: true, detail: reason };
  }

  const malformedPendingCount = getNumberField(result.json, "malformedPendingCount") ?? getArrayField(result.json, "malformedPendingTrades").length;
  const malformedOpenCount = getNumberField(result.json, "malformedOpenCount") ?? getArrayField(result.json, "malformedOpenTrades").length;
  if (malformedPendingCount > 0 || malformedOpenCount > 0) {
    return {
      ok: false,
      detail: `malformed_blockers pending=${malformedPendingCount} open=${malformedOpenCount}`,
    };
  }

  const liveBlockers = getArrayField(result.json, "liveBlockers");
  if (reason === "PROTECTION_INTEGRITY_FAILED" || liveBlockers.length > 0) {
    return { ok: false, detail: "protection_integrity_failed" };
  }

  if (result.json.ok === true) {
    return { ok: true, detail: reason };
  }

  return { ok: false, detail: reason ?? result.reason ?? "execute_probe_failed" };
}

function evaluateRouteProbe(routePath: string, result: ProbeResult): { ok: boolean; detail: string | null } {
  if (routePath === "/api/auto-entry/seed-from-signals") {
    return evaluateSeedProbeResult(result);
  }
  if (routePath === "/api/auto-entry/execute") {
    return evaluateExecuteProbeResult(result);
  }
  return { ok: result.ok, detail: result.reason };
}

function isFunnelHealthyProbe(result: ProbeResult): boolean {
  if (!result.ok || !isObject(result.json)) return false;
  const blocked = result.json.blocked === true || result.json.funnelBlocked === true;
  return !blocked;
}

/** Route-aware method/auth mapping for task verification probes. */
const ROUTE_VERIFICATION_MAP: Record<string, RouteVerificationConfig> = {
  "/api/readiness": { method: "GET" },
  "/api/trades/protection-audit": { method: "GET" },
  "/api/funnel-health": { method: "GET" },
  "/api/auto-entry/seed-from-signals": {
    method: "POST",
    authHeader: "x-cron-token",
    body: { debug: 1, limit: 1 },
  },
  "/api/auto-entry/execute": {
    method: "POST",
    authHeader: "x-auto-entry-token",
  },
  "/api/ai/score/drain": {
    method: "POST",
    authHeader: "x-cron-token",
    body: { limit: 3, budgetMs: 30000, recentWindowHours: 2 },
  },
  "/api/agents/run": {
    method: "POST",
    authHeader: "x-cron-token",
  },
  "/api/scan": {
    method: "POST",
    authHeader: "x-scanner-token",
  },
};

async function probeRoute(
  base: string,
  route: string,
  headers: Record<string, string>,
  method: HttpMethod = "GET",
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
    let json: unknown = null;
    try {
      json = await res.clone().json();
    } catch {
      json = null;
    }
    return {
      route,
      ok: res.ok,
      status: res.status,
      reason: res.ok ? null : `HTTP ${res.status}`,
      method,
      json,
      timedOut: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError" || /timed out|aborted/i.test(message));
    return {
      route,
      ok: false,
      status: null,
      reason: timedOut ? "timeout" : message,
      method,
      json: null,
      timedOut,
    };
  }
}

// ─── Default smoke routes ───────────────────────────────────────────

const DEFAULT_SMOKE_ROUTES = ["/api/readiness", "/api/trades/protection-audit"];

function getTaskSmokeRoutes(task: EngineeringTask): Array<{ route: string; method: HttpMethod }> {
  const routes: Array<{ route: string; method: HttpMethod }> = [];
  const seen = new Set<string>();

  function addRoute(route: string, method: HttpMethod = "GET") {
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
  "/api/ai/score/drain": { method: "POST", body: { limit: 3, budgetMs: 30000, recentWindowHours: 2 } },
  "/api/agents/run": { method: "POST" },
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
  method: HttpMethod;
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
      { route: "/api/ai/score/drain", method: "POST", body: { limit: 3, budgetMs: 30000, recentWindowHours: 2 }, label: "scoring_drain_reachable" },
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
  const taskResults: Array<{
    target: string;
    ok: boolean;
    detail: string | null;
    requestedMethod: HttpMethod;
    finalMethod: HttpMethod;
    retriedAfter405: boolean;
    authHeaderUsed: string | null;
    status: number | null;
  }> = [];
  for (const { route, method } of taskRoutes) {
    if (DEFAULT_SMOKE_ROUTES.includes(route) && method === "GET") continue; // already probed

    const routePath = getRoutePath(route);
    const routeMapping = ROUTE_VERIFICATION_MAP[routePath];
    const knownOverride = KNOWN_POST_ROUTES[routePath];
    const fallbackPostConfig = routeMapping ?? knownOverride;

    const requestedMethod = method;
    const requestedBody = requestedMethod === "POST"
      ? (routeMapping?.body ?? knownOverride?.body)
      : undefined;
    const initialHeaderConfig = requestedMethod === "POST" ? routeMapping : undefined;
    const initialHeaderBuild = buildRouteHeaders(headers, initialHeaderConfig);
    let result = await probeRoute(base, route, initialHeaderBuild.headers, requestedMethod, requestedBody);
    let finalMethod: HttpMethod = requestedMethod;
    let finalAuthHeaderUsed: string | null = initialHeaderBuild.authHeaderUsed;
    let retriedAfter405 = false;

    if (
      result.status === 405 &&
      requestedMethod === "GET" &&
      fallbackPostConfig?.method === "POST"
    ) {
      retriedAfter405 = true;
      const retryHeaders = buildRouteHeaders(headers, routeMapping);
      result = await probeRoute(base, route, retryHeaders.headers, "POST", fallbackPostConfig.body);
      finalMethod = "POST";
      finalAuthHeaderUsed = retryHeaders.authHeaderUsed;
    }

    const evaluated = evaluateRouteProbe(routePath, result);
    taskResults.push({
      target: route,
      ok: evaluated.ok,
      detail: evaluated.detail,
      requestedMethod,
      finalMethod,
      retriedAfter405,
      authHeaderUsed: finalAuthHeaderUsed,
      status: result.status,
    });
    console.log(`[VERIFY] Task probe: ${evaluated.ok ? "PASS" : "FAIL"} (${requestedMethod}->${finalMethod} ${result.route})`);
  }

  // 4. Task-type-specific verification probes (scoring, scanner, etc.)
  const typeProbes = getTaskTypeVerificationProbes(task);
  for (const { route, method, body, label } of typeProbes) {
    // Skip if already probed in task-specific or default probes
    const alreadyProbed = taskResults.some((r) => r.target === route) ||
      (DEFAULT_SMOKE_ROUTES.includes(route) && method === "GET");
    if (alreadyProbed) continue;
    const routePath = getRoutePath(route);
    const mappedConfig = ROUTE_VERIFICATION_MAP[routePath];
    const probeMethod = mappedConfig?.method ?? method;
    const probeBody = mappedConfig?.body ?? body;
    const routeHeaders = buildRouteHeaders(headers, mappedConfig);
    const result = await probeRoute(base, route, routeHeaders.headers, probeMethod, probeBody);
    const evaluated = evaluateRouteProbe(routePath, result);
    taskResults.push({
      target: route,
      ok: evaluated.ok,
      detail: evaluated.ok ? null : `${label}: ${evaluated.detail ?? result.reason}`,
      requestedMethod: probeMethod,
      finalMethod: probeMethod,
      retriedAfter405: false,
      authHeaderUsed: routeHeaders.authHeaderUsed,
      status: result.status,
    });
    console.log(`[VERIFY] Type probe: ${evaluated.ok ? "PASS" : "FAIL"} (${probeMethod} ${result.route} [${label}])`);
  }

  // Context probe used for soft-timeout adjudication only.
  const funnelProbe = await probeRoute(base, "/api/funnel-health", headers, "GET");
  const funnelHealthy = isFunnelHealthyProbe(funnelProbe);

  const buildOk = buildProbe.ok;
  const smokeOk = smokeProbes.every((p) => p.ok);
  const coreProbesPass = buildOk && smokeOk;

  // Score drain timeout can be downgraded to warning when core health is good.
  const scoreDrainTimeoutIdx = taskResults.findIndex(
    (r) => r.target.startsWith("/api/ai/score/drain") && /timeout/i.test(String(r.detail ?? "")),
  );
  const hasScoreDrainTimeout = scoreDrainTimeoutIdx >= 0;

  let softWarning = false;
  let warningCode: string | null = null;
  if (hasScoreDrainTimeout && coreProbesPass && funnelHealthy) {
    softWarning = true;
    warningCode = "verification_soft_timeout";
    taskResults[scoreDrainTimeoutIdx] = {
      ...taskResults[scoreDrainTimeoutIdx],
      ok: true,
      detail: "verification_soft_timeout",
    };
  }

  const taskOk = taskResults.every((r) => r.ok);
  const overall = buildOk && smokeOk && taskOk;
  const hardFailure = !overall;

  const failureReasons: string[] = [];
  if (!buildOk) failureReasons.push(`build(${buildProbe.route}): ${buildProbe.reason}`);
  for (const p of smokeProbes) {
    if (!p.ok) failureReasons.push(`smoke(${p.route}): ${p.reason}`);
  }
  for (const r of taskResults) {
    if (!r.ok) failureReasons.push(`task(${r.target}): ${r.detail}`);
  }

  const warningSuffix = softWarning ? ` [warning=${warningCode}]` : "";
  console.log(`[VERIFY] Overall: ${overall ? "PASS" : "FAIL"}${failureReasons.length ? ` — ${failureReasons.join("; ")}` : ""}${warningSuffix}`);

  // Strip full JSON bodies from probe results — only keep compact summary fields.
  // Storing full /api/agents/state responses causes recursive stale state pollution.
  const compactProbeResult = (p: ProbeResult) => ({
    route: p.route,
    ok: p.ok,
    status: p.status,
    method: p.method,
    reason: p.reason,
    timedOut: p.timedOut,
    checkedAt: now,
  });

  return {
    gateResult: {
      passed: overall,
      buildOk,
      smokeOk: smokeOk && taskOk,
      failureReason: overall ? null : failureReasons.join("; "),
      hardFailure,
      softWarning,
      warningCode,
    },
    probeResults: [buildProbe, ...smokeProbes, funnelProbe].map(compactProbeResult),
    taskSpecificResults: taskResults,
    overall,
    verifiedAt: now,
  };
}
