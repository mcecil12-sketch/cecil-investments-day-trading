export function requireMarketLoopOnly(headers: Headers) {
  const runSource = headers.get("x-run-source") || "unknown";
  const runId = headers.get("x-run-id") || "none";
  const allow = (process.env.MARKET_LOOP_ONLY ?? "1") === "1";

  if (allow && runSource !== "github-actions") {
    return {
      ok: false as const,
      status: 403,
      body: { ok: false, error: "market_loop_only", runSource, runId },
    };
  }

  return {
    ok: true as const,
    runSource,
    runId,
  };
}

