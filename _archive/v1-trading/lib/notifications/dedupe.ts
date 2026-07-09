import { redis } from "@/lib/redis";

const PREFIX = "notify:dedupe:v1";

export async function shouldSendNotification(eventKey: string, ttlSec: number) {
  if (!redis) return true;
  const key = `${PREFIX}:${eventKey}`;
  const ok = await redis.set(key, "1", { nx: true, ex: ttlSec });
  return Boolean(ok);
}

export async function clearNotificationDedupe(eventKey: string) {
  if (!redis) return;
  const key = `${PREFIX}:${eventKey}`;
  await redis.del(key);
}
