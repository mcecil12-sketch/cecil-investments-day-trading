const ALPACA_KEY_ID =
  process.env.ALPACA_API_KEY_ID || process.env.ALPACA_KEY_ID;
const ALPACA_SECRET_KEY =
  process.env.ALPACA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY;

// Trading base URL: prefer explicit paper/live vars, fall back to generic/base
const ALPACA_BASE_URL =
  process.env.ALPACA_BASE_URL ||
  process.env.ALPACA_PAPER_BASE_URL ||
  "https://paper-api.alpaca.markets/v2";

// Market data base URL (v2)
const ALPACA_DATA_BASE_URL =
  process.env.ALPACA_DATA_BASE_URL || "https://data.alpaca.markets/v2";

export type AlpacaBar = {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
};

async function alpacaFetch(url: string, init: RequestInit = {}) {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET_KEY) {
    throw new Error("Missing Alpaca API keys.");
  }

  const headers = {
    "APCA-API-KEY-ID": ALPACA_KEY_ID,
    "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
    ...(init.headers || {}),
  };

  return fetch(url, { ...init, headers });
}

export async function fetchRecentBars(
  symbol: string,
  timeframe: string,
  limit = 100,
  endTimeIso?: string
): Promise<AlpacaBar[]> {
  const tf = timeframe || "1Min";

  const end = endTimeIso ? new Date(endTimeIso) : new Date();
  const start = new Date(end.getTime() - 5 * 24 * 60 * 60 * 1000);

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const feed = process.env.ALPACA_DATA_FEED || "iex";

  const url =
    `https://data.alpaca.markets/v2/stocks/bars` +
    `?symbols=${encodeURIComponent(symbol)}` +
    `&timeframe=${encodeURIComponent(tf)}` +
    `&start=${encodeURIComponent(startIso)}` +
    `&end=${encodeURIComponent(endIso)}` +
    `&limit=${encodeURIComponent(String(limit))}` +
    `&feed=${encodeURIComponent(feed)}` +
    `&adjustment=raw`;

  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": process.env.ALPACA_API_KEY || "",
      "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET || "",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Alpaca bars failed ${res.status}: ${txt.slice(0, 300)}`);
  }

  const json = await res.json();

  const bars: AlpacaBar[] =
    json?.bars?.[symbol] ||
    json?.bars ||
    json?.[symbol] ||
    [];

  const out = Array.isArray(bars) ? bars.slice() : [];
  out.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());

  return out;
}

export interface SubmitOrderParams {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type?: "market" | "limit";
  timeInForce?: "day" | "gtc";
  limitPrice?: number;
  extendedHours?: boolean;
}

export interface AlpacaOrderResponse {
  id: string;
  status: string;
  symbol: string;
  qty: string;
  filled_qty: string;
  side: string;
  type: string;
  time_in_force: string;
  created_at: string;
  [key: string]: any;
}

export async function submitOrder(
  params: SubmitOrderParams
): Promise<AlpacaOrderResponse> {
  const body: Record<string, any> = {
    symbol: params.symbol,
    qty: params.qty,
    side: params.side,
    type: params.type ?? "market",
    time_in_force: params.timeInForce ?? "day",
    extended_hours: params.extendedHours ?? false,
  };

  if (params.type === "limit" && params.limitPrice) {
    body.limit_price = params.limitPrice;
  }

  const res = await alpacaFetch(`${ALPACA_BASE_URL}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(text || "Order failed");

  return JSON.parse(text);
}

// ---------------- Trading helpers ----------------

export type AlpacaOrder = {
  id: string;
  client_order_id?: string;
  status?: string;
  [key: string]: any;
};

export async function getOrder(orderId: string): Promise<AlpacaOrder> {
  const res = await alpacaFetch(`${ALPACA_BASE_URL}/orders/${encodeURIComponent(orderId)}?nested=true`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to fetch order ${orderId}`);
  }
  return res.json();
}

export async function replaceOrder(
  orderId: string,
  body: Record<string, any>
): Promise<AlpacaOrder> {
  const res = await alpacaFetch(`${ALPACA_BASE_URL}/orders/${encodeURIComponent(orderId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to replace order ${orderId}`);
  }
  return res.json();
}

export type AlpacaPosition = {
  symbol: string;
  qty: string;
  [key: string]: any;
};

export async function getPositions(
  symbol?: string
): Promise<AlpacaPosition[] | AlpacaPosition> {
  const path = symbol ? `/positions/${encodeURIComponent(symbol)}` : "/positions";
  const res = await alpacaFetch(`${ALPACA_BASE_URL}${path}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to fetch positions");
  }
  return res.json();
}

// ---------------- Quotes ----------------

export type LatestQuote = {
  symbol: string;
  bid_price: number;
  ask_price: number;
  bid_size: number;
  ask_size: number;
  timestamp: string;
};

export async function getLatestQuote(symbol: string): Promise<LatestQuote> {
  const res = await alpacaFetch(
    `${ALPACA_DATA_BASE_URL}/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
    { method: "GET" }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to fetch quote for ${symbol}`);
  }
  const data = await res.json();
  if (!data?.quote) {
    throw new Error(`No quote returned for ${symbol}`);
  }
  return { ...data.quote, symbol: data.quote.symbol ?? symbol };
}
