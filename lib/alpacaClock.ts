export type AlpacaClock = {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
};

export type AlpacaClockSafeResult =
  | { ok: true; is_open: boolean; timestamp?: string; next_open?: string; next_close?: string }
  | { ok: false; error: string; status?: number };

function getAlpacaTradingBaseUrl() {
  return (
    process.env.ALPACA_TRADING_BASE_URL ||
    process.env.ALPACA_BASE_URL ||
    "https://paper-api.alpaca.markets"
  ).replace(/\/$/, "");
}

function getAlpacaApiKey() {
  return (
    process.env.ALPACA_API_KEY ||
    process.env.ALPACA_API_KEY_ID ||
    process.env.ALPACA_KEY_ID ||
    ""
  );
}

function getAlpacaApiSecret() {
  return (
    process.env.ALPACA_API_SECRET ||
    process.env.ALPACA_API_SECRET_KEY ||
    process.env.ALPACA_SECRET_KEY ||
    ""
  );
}

export async function fetchAlpacaClock(): Promise<AlpacaClock> {
  const key = getAlpacaApiKey();
  const secret = getAlpacaApiSecret();

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

export async function fetchAlpacaClockSafe(): Promise<AlpacaClockSafeResult> {
  const key = getAlpacaApiKey();
  const secret = getAlpacaApiSecret();

  if (!key || !secret) {
    return { ok: false, error: "missing_alpaca_keys" };
  }

  const url = `${getAlpacaTradingBaseUrl()}/v2/clock`;
  const resp = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
    },
    cache: "no-store",
  });

  if (!resp.ok) {
    return { ok: false, error: "alpaca_clock_failed", status: resp.status };
  }

  const json = await resp.json();
  return {
    ok: true,
    is_open: Boolean(json?.is_open),
    timestamp: json?.timestamp,
    next_open: json?.next_open,
    next_close: json?.next_close,
  };
}
