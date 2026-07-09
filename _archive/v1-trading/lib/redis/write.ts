import { ttlSeconds, type RedisTtlKey } from "./ttls";

// This helper standardizes how we write expiring keys.
// Works with Upstash Redis client that supports { ex }.
export async function redisSetWithTtl(
  redis: any,
  key: string,
  value: string,
  ttlKey: RedisTtlKey
) {
  const ex = ttlSeconds(ttlKey);
  return redis.set(key, value, { ex });
}

// If we sometimes write without options, call this immediately after.
export async function redisExpire(
  redis: any,
  key: string,
  ttlKey: RedisTtlKey
) {
  const ex = ttlSeconds(ttlKey);
  return redis.expire(key, ex);
}
