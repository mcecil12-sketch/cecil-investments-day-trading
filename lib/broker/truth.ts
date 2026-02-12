import { alpacaRequest } from "@/lib/alpaca";
import { redis } from "@/lib/redis";

const BROKER_TRUTH_CACHE_KEY = "broker:truth:v1";
const CACHE_TTL_SEC = 45; // Cache for 45 seconds to avoid hammering Alpaca

/**
 * Broker truth snapshot from Alpaca: positions and open orders.
 * This is the single source of truth for entry gating.
 */
export type BrokerTruth = {
  fetchedAt: string;
  positionsCount: number;
  openOrdersCount: number;
  positions: Array<{ 
    symbol: string; 
    qty: number;
    avg_entry_price?: string | number;
    created_at?: string;
  }>;
  openOrders: Array<{ id: string; symbol: string; side: string; status: string }>;
  error?: string;
};

/**
 * Fetch broker truth from Alpaca: positions and open orders.
 * Safe: handles timeouts, try/catch, and caches for 45-60 seconds.
 */
export async function fetchBrokerTruth(): Promise<BrokerTruth> {
  const now = new Date().toISOString();
  
  // Try to get from cache first
  if (redis) {
    try {
      const cached = await redis.get<BrokerTruth>(BROKER_TRUTH_CACHE_KEY);
      if (cached) {
        console.log("[broker-truth] cache hit", { fetchedAt: cached.fetchedAt });
        return cached;
      }
    } catch (err) {
      console.warn("[broker-truth] cache read error", err);
    }
  }

  const truth: BrokerTruth = {
    fetchedAt: now,
    positionsCount: 0,
    openOrdersCount: 0,
    positions: [],
    openOrders: [],
  };

  try {
    // Fetch positions with timeout
    const positionsPromise = fetchPositions();
    const ordersPromise = fetchOpenOrders();

    const [positionsResult, ordersResult] = await Promise.all([
      promiseWithTimeout(positionsPromise, 10000),
      promiseWithTimeout(ordersPromise, 10000),
    ]);

    if (positionsResult.ok) {
      truth.positions = positionsResult.data;
      truth.positionsCount = positionsResult.data.length;
    } else {
      truth.error = `positions_fetch_failed: ${positionsResult.error}`;
      console.error("[broker-truth] positions fetch failed", positionsResult.error);
    }

    if (ordersResult.ok) {
      truth.openOrders = ordersResult.data;
      truth.openOrdersCount = ordersResult.data.length;
    } else {
      truth.error = `${truth.error ? truth.error + "; " : ""}orders_fetch_failed: ${ordersResult.error}`;
      console.error("[broker-truth] orders fetch failed", ordersResult.error);
    }
  } catch (err) {
    truth.error = `unexpected_error: ${String(err)}`;
    console.error("[broker-truth] unexpected error", err);
  }

  // Cache the result
  if (redis && !truth.error) {
    try {
      await redis.set(BROKER_TRUTH_CACHE_KEY, JSON.stringify(truth), {
        ex: CACHE_TTL_SEC,
      });
      console.log("[broker-truth] cached", { positionsCount: truth.positionsCount, ordersCount: truth.openOrdersCount });
    } catch (err) {
      console.warn("[broker-truth] cache write error", err);
    }
  }

  return truth;
}

/**
 * Fetch positions from Alpaca GET /v2/positions
 */
async function fetchPositions(): Promise<
  | { ok: true; data: Array<{ symbol: string; qty: number }> }
  | { ok: false; error: string }
> {
  try {
    const resp = await alpacaRequest({
      method: "GET",
      path: "/v2/positions",
    });

    if (!resp.ok) {
      return {
        ok: false,
        error: `http_${resp.status}: ${resp.text?.slice(0, 200) || ""}`,
      };
    }

    const parsed = JSON.parse(resp.text || "[]");
    const positions = Array.isArray(parsed)
      ? parsed
          .filter((p: any) => p.symbol && typeof p.qty !== "undefined")
          .map((p: any) => ({
            symbol: String(p.symbol),
            qty: Number(p.qty),
          }))
      : [];

    return { ok: true, data: positions };
  } catch (err) {
    return {
      ok: false,
      error: `parse_error: ${String(err)}`,
    };
  }
}

/**
 * Fetch open orders from Alpaca GET /v2/orders?status=open
 */
async function fetchOpenOrders(): Promise<
  | { ok: true; data: Array<{ id: string; symbol: string; side: string; status: string }> }
  | { ok: false; error: string }
> {
  try {
    const resp = await alpacaRequest({
      method: "GET",
      path: "/v2/orders?status=open",
    });

    if (!resp.ok) {
      return {
        ok: false,
        error: `http_${resp.status}: ${resp.text?.slice(0, 200) || ""}`,
      };
    }

    const parsed = JSON.parse(resp.text || "[]");
    const orders = Array.isArray(parsed)
      ? parsed
          .filter((o: any) => o.id && o.symbol)
          .map((o: any) => ({
            id: String(o.id),
            symbol: String(o.symbol),
            side: String(o.side || ""),
            status: String(o.status || ""),
          }))
      : [];

    return { ok: true, data: orders };
  } catch (err) {
    return {
      ok: false,
      error: `parse_error: ${String(err)}`,
    };
  }
}

/**
 * Utility: wrap promise with timeout
 */
function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), timeoutMs)
    ),
  ]);
}

/**
 * Clear broker truth cache (for testing or force refresh)
 */
export async function clearBrokerTruthCache(): Promise<void> {
  if (redis) {
    try {
      await redis.del(BROKER_TRUTH_CACHE_KEY);
    } catch (err) {
      console.warn("[broker-truth] cache clear error", err);
    }
  }
}
