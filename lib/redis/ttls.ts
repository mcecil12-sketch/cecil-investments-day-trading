export const REDIS_TTL_SECONDS = {
  SIGNAL: 60 * 60 * 24, // 24h
  FUNNEL: 60 * 60 * 48, // 48h
  PERFORMANCE: 60 * 60 * 24 * 90, // 90d
} as const;

export type RedisTtlKey = keyof typeof REDIS_TTL_SECONDS;

export function ttlSeconds(key: RedisTtlKey): number {
  return REDIS_TTL_SECONDS[key];
}
