/**
 * Safe commit gate — fail-closed smoke validation before agent pushes.
 * Calls internal routes to verify system health.
 */

export type SafeGateTaskType = "protection/risk" | "agent/tasking";

type SmokeResult = {
  route: string;
  ok: boolean;
  status?: number;
  error?: string;
};

export type SafeGateResult = {
  passed: boolean;
  taskType: SafeGateTaskType;
  smokeResults: SmokeResult[];
  failureReason?: string;
};

const SMOKE_ROUTES: Record<SafeGateTaskType, string[]> = {
  "protection/risk": ["/api/trades/protection-audit", "/api/readiness"],
  "agent/tasking": ["/api/agents/priorities", "/api/agents/execute"],
};

function resolveBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  return "http://localhost:3000";
}

/**
 * Run smoke validation for the given task type.
 * Fail-closed: any error or non-2xx is a failure.
 */
export async function runSafeGate(
  taskType: SafeGateTaskType,
): Promise<SafeGateResult> {
  const routes = SMOKE_ROUTES[taskType];
  if (!routes || routes.length === 0) {
    return {
      passed: false,
      taskType,
      smokeResults: [],
      failureReason: "unknown_task_type",
    };
  }

  const baseUrl = resolveBaseUrl();
  const cronToken = process.env.CRON_TOKEN || "";
  const smokeResults: SmokeResult[] = [];

  for (const route of routes) {
    try {
      const resp = await fetch(`${baseUrl}${route}`, {
        method: "GET",
        headers: { "x-cron-token": cronToken },
        signal: AbortSignal.timeout(10_000),
      });
      smokeResults.push({ route, ok: resp.ok, status: resp.status });
    } catch (err) {
      smokeResults.push({
        route,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const allOk = smokeResults.every((r) => r.ok);
  return {
    passed: allOk,
    taskType,
    smokeResults,
    failureReason: allOk ? undefined : "smoke_route_failure",
  };
}
