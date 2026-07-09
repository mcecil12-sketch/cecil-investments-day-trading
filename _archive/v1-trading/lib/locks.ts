import { redis } from "@/lib/redis";

export async function withRedisLock<T>(args: {
  key: string;
  ttlSeconds: number;
  owner: string;
  fn: () => Promise<T>;
}): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const { key, ttlSeconds, owner, fn } = args;
  const lockKey = `lock:${key}`;
  const token = `${owner}:${cryptoRandom()}`;

  if (!redis) return { ok: false, error: "redis_unavailable" };

  try {
    const acquired = await redis.set(lockKey, token, { nx: true, ex: ttlSeconds });
    if (!acquired) return { ok: false, error: "LOCKED" };

    const value = await fn();
    return { ok: true, value };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try {
      const cur = await redis.get(lockKey);
      if (cur === token) await redis.del(lockKey);
    } catch {}
  }
}

export async function lockTtlSeconds(key: string) {
  const lockKey = `lock:${key}`;
  if (!redis) return { key: lockKey, ttl: -1, value: null };
  const ttl = await redis.ttl(lockKey);
  const val = await redis.get(lockKey);
  return { key: lockKey, ttl, value: val };
}

export async function unlockLockKey(lockKey: string) {
  if (!redis) return { lockKey, ttlWas: -1 };
  const ttl = await redis.ttl(lockKey);
  await redis.del(lockKey);
  return { lockKey, ttlWas: ttl };
}

function cryptoRandom() {
  const g: any = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
