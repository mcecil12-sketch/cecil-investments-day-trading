const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC";

export interface Sp500PricePoint {
  date: Date;
  close: number;
}

/**
 * Pulls daily ^GSPC closes from Yahoo Finance's public chart endpoint (the
 * same one yfinance scrapes) — no API key required. Range is fetched wide
 * (10y) so a single refresh covers every rolling window this app computes.
 */
export async function fetchSp500History(): Promise<Sp500PricePoint[]> {
  const url = `${YAHOO_CHART_URL}?range=10y&interval=1d`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; portfolio-benchmark/1.0)" },
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance request failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  const result = body?.chart?.result?.[0];
  if (!result) {
    const errorMessage = body?.chart?.error?.description ?? "no result in response";
    throw new Error(`Yahoo Finance returned no ^GSPC data: ${errorMessage}`);
  }

  const timestamps: number[] = result.timestamp ?? [];
  const closes: Array<number | null> = result.indicators?.quote?.[0]?.close ?? [];

  const points: Sp500PricePoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null) continue;
    points.push({ date: new Date(timestamps[i] * 1000), close });
  }
  return points;
}
