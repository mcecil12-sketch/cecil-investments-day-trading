import { recordHeartbeat } from "@/lib/aiMetrics";

/**
 * Updates the heartbeat timestamp so the AI health pill stays accurate.
 */
export async function touchHeartbeat() {
  try {
    await recordHeartbeat();
  } catch (error) {
    console.warn("[aiHeartbeat] failed to touch heartbeat", error);
  }
}
