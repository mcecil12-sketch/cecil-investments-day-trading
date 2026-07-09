import { redis } from "@/lib/redis";

type NotifyOnceResult = {
  shouldNotify: boolean;
  reason: "already_notified" | "first_time" | "no_redis";
};

export async function notifyOnce(key: string, ttlSeconds = 60 * 60 * 24 * 2): Promise<NotifyOnceResult> {
  if (!redis) return { shouldNotify: true, reason: "no_redis" };

  const existing = await redis.get<string>(key);
  if (existing) {
    return { shouldNotify: false, reason: "already_notified" };
  }

  try {
    // Upstash-compatible TTL
    await redis.set(key, "1", { ex: ttlSeconds });
  } catch {
    try {
      await redis.set(key, "1");
    } catch {
      // if even set fails, still proceed (best effort)
    }
  }

  return { shouldNotify: true, reason: "first_time" };
}
