import { redis } from "@/lib/redis";
import { nowETDate, etParts } from "@/lib/performance/time";
import { num } from "@/lib/performance/math";

export type EquityPoint = {
  ts: string;
  dateET: string;
  hhmm: number;

  equity: number;
  cash: number;
  buyingPower: number;

  unrealizedPnL: number;
  realizedPnL?: number;

  positionsCount: number;
  note?: string;
  source?: string;
  runId?: string;
};

const hasRedis = () => !!redis;

function keyPoints(dateET: string) {
  return `perf:equity:${dateET}:points`;
}
function keyLatest(dateET: string) {
  return `perf:equity:${dateET}:latest`;
}
const KEY_DATES = "perf:equity:dates";

export async function recordEquityPoint(p: Partial<EquityPoint>) {
  if (!hasRedis()) return { ok: true, stored: false, redis: false };

  const ts = String(p.ts || new Date().toISOString());
  const parts = etParts(ts);
  const dateET = String(p.dateET || parts.dateET || nowETDate());
  const hhmm = Number.isFinite(p.hhmm as any) ? Number(p.hhmm) : parts.hhmm;

  const point: EquityPoint = {
    ts,
    dateET,
    hhmm,
    equity: num((p as any).equity, 0) ?? 0,
    cash: num((p as any).cash, 0) ?? 0,
    buyingPower: num((p as any).buyingPower, 0) ?? 0,
    unrealizedPnL: num((p as any).unrealizedPnL, 0) ?? 0,
    realizedPnL: (p as any).realizedPnL != null ? (num((p as any).realizedPnL, 0) ?? 0) : undefined,
    positionsCount: num((p as any).positionsCount, 0) ?? 0,
    note: p.note,
    source: p.source,
    runId: p.runId,
  };

  try {
    const pipe = redis!.multi();
    pipe.sadd(KEY_DATES, dateET);
    pipe.hset(keyLatest(dateET), {
      ts: point.ts,
      hhmm: String(point.hhmm),
      equity: String(point.equity),
      cash: String(point.cash),
      buyingPower: String(point.buyingPower),
      unrealizedPnL: String(point.unrealizedPnL),
      positionsCount: String(point.positionsCount),
      note: point.note || "",
      source: point.source || "",
      runId: point.runId || "",
    });
    pipe.lpush(keyPoints(dateET), JSON.stringify(point));
    pipe.ltrim(keyPoints(dateET), 0, 999);
    await pipe.exec();

    return { ok: true, stored: true, redis: true, point };
  } catch (e: any) {
    return { ok: true, stored: false, redis: true, degraded: true, error: String(e?.message || e) };
  }
}

export async function readEquityPoints(dateET: string, limit = 200) {
  if (!hasRedis()) return { ok: true, redis: false, dateET, points: [] as EquityPoint[] };

  try {
    const raw = await redis!.lrange(keyPoints(dateET), 0, Math.max(0, limit - 1));
    const points = (raw || [])
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as EquityPoint[];

    points.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return { ok: true, redis: true, dateET, points };
  } catch {
    return { ok: true, redis: true, degraded: true, dateET, points: [] as EquityPoint[] };
  }
}

export async function readEquityLatest(dateET: string) {
  if (!hasRedis()) return { ok: true, redis: false, dateET, latest: null as any };

  try {
    const h = await redis!.hgetall(keyLatest(dateET));
    return { ok: true, redis: true, dateET, latest: h && Object.keys(h).length ? h : null };
  } catch {
    return { ok: true, redis: true, degraded: true, dateET, latest: null };
  }
}
