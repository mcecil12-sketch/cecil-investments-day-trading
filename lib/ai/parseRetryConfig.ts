const DEFAULT_MAX_PARSE_RETRY = 2;

function toSafeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  return Math.max(0, rounded);
}

export type ParseRetryConfig = {
  retryOnParseFail: boolean;
  maxParseRetry: number;
};

export function getParseRetryConfig(): ParseRetryConfig {
  const retryOnParseFail = (process.env.AI_SCORE_RETRY_ON_PARSE_FAIL ?? "1") === "1";
  const maxParseRetry = toSafeInt(process.env.MAX_PARSE_RETRY, DEFAULT_MAX_PARSE_RETRY);
  return { retryOnParseFail, maxParseRetry };
}
