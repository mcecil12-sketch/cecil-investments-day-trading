export type AlpacaClock = {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
};

function getAlpacaTradingBaseUrl() {
  return (
    process.env.ALPACA_TRADING_BASE_URL ||
    process.env.ALPACA_BASE_URL ||
    "https://paper-api.alpaca.markets"
  ).replace(/\/$/, "");
}

export async function fetchAlpacaClock(): Promise<AlpacaClock> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;

  if (!key || !secret) {
    throw new Error("Missing ALPACA_API_KEY / ALPACA_API_SECRET");
  }

  const url = `${getAlpacaTradingBaseUrl()}/v2/clock`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Alpaca clock error ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.json()) as AlpacaClock;
}
