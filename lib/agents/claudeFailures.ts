import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Collects the reason behind every Claude call that fell back (or failed)
 * during a run, so scanHealth.ts can surface it instead of the fallback being
 * silent. Fallback behavior itself is unchanged — callers just also call
 * recordClaudeFailure(). Outside a captureClaudeFailures() scope (e.g. a
 * manual one-off call) recording is a no-op beyond a console line.
 */
export interface ClaudeFailure {
  source: string;
  reason: string;
}

const store = new AsyncLocalStorage<ClaudeFailure[]>();

export const MISSING_KEY_REASON = "APP_ANTHROPIC_API_KEY is not configured";

export function recordClaudeFailure(source: string, reason: string): void {
  console.error(`[claude-fallback] ${source}: ${reason}`);
  store.getStore()?.push({ source, reason });
}

/** Turns an SDK/network error into a short, human-readable reason; billing/credit errors are called out explicitly. */
export function describeClaudeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number } | null)?.status;
  if (/credit balance|billing|purchase credits|insufficient (funds|credit)/i.test(message)) {
    return `BILLING/CREDIT: ${message.slice(0, 160)}`;
  }
  if (status === 401 || status === 403) return `AUTH (${status}): ${message.slice(0, 160)}`;
  if (status === 429) return `RATE LIMITED (429): ${message.slice(0, 160)}`;
  return `${status ? `API error ${status}` : "Error"}: ${message.slice(0, 160)}`;
}

export function recordClaudeError(source: string, err: unknown): void {
  recordClaudeFailure(source, describeClaudeError(err));
}

export async function captureClaudeFailures<T>(
  fn: () => Promise<T>,
): Promise<{ value: T | undefined; error: unknown; failures: ClaudeFailure[] }> {
  const failures: ClaudeFailure[] = [];
  return store.run(failures, async () => {
    try {
      return { value: await fn(), error: undefined, failures };
    } catch (error) {
      return { value: undefined, error, failures };
    }
  });
}

/** Failures recorded so far in the current capture scope (empty outside one). */
export function getCapturedClaudeFailures(): ClaudeFailure[] {
  return [...(store.getStore() ?? [])];
}
