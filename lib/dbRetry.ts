import { Prisma } from "@/lib/generated/prisma";

const COLD_START_RETRY_DELAYS_MS = [2000, 4000, 8000];

/**
 * Neon's free-tier compute autosuspends after 5 minutes idle. The first
 * connection after a suspend (typically an off-hours cron) can fail with
 * PrismaClientInitializationError while the endpoint wakes, even though
 * nothing is actually wrong. Retries only that connection-level error —
 * query/validation errors are real bugs and are rethrown immediately.
 */
export async function withColdStartRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const totalAttempts = COLD_START_RETRY_DELAYS_MS.length + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientInitializationError)) throw err;
      if (attempt === totalAttempts) throw err;

      const delayMs = COLD_START_RETRY_DELAYS_MS[attempt - 1];
      console.warn(
        `[${label}] cold start retry ${attempt}/${totalAttempts} — Neon connection failed (${err.message}), retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`[${label}] withColdStartRetry: unreachable`);
}
