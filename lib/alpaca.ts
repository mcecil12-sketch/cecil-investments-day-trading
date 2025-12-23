function stripV2(base: string) {
  return base.replace(/\/+$/, "").replace(/\/v2$/, "");
}

export const TRADING_BASE = stripV2(
  process.env.ALPACA_BASE_URL ||
    process.env.ALPACA_PAPER_BASE_URL ||
    "https://paper-api.alpaca.markets"
);

export const DATA_BASE = stripV2(
  process.env.ALPACA_DATA_BASE_URL || "https://data.alpaca.markets"
);

export const ALPACA_FEED = process.env.ALPACA_DATA_FEED || "iex";

const KEY_ID =
  process.env.ALPACA_API_KEY_ID ||
  process.env.ALPACA_API_KEY ||
  process.env.ALPACA_KEY_ID ||
  "";

const SECRET =
  process.env.ALPACA_API_SECRET_KEY ||
  process.env.ALPACA_API_SECRET ||
  process.env.ALPACA_SECRET_KEY ||
  "";

export function hasAlpacaCreds() {
  return Boolean(KEY_ID && SECRET);
}

export function alpacaHeaders() {
  if (!KEY_ID || !SECRET) {
    throw new Error("Missing Alpaca credentials (key/secret).");
  }
  return {
    "APCA-API-KEY-ID": KEY_ID,
    "APCA-API-SECRET-KEY": SECRET,
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  };
}

export function tradingUrl(path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${TRADING_BASE}/v2${p}`;
}

export function dataUrl(path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${DATA_BASE}/v2${p}`;
}

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
  const headers = {
    ...alpacaHeaders(),
    ...(init.headers || {}),
  };

  return fetch(url, {
    ...init,
    headers,
    cache: "no-store",
  });
}

const WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export function computeBarsWindow(endTimeIso?: string) {
  const end = endTimeIso ? new Date(endTimeIso) : new Date();
  const start = new Date(end.getTime() - WINDOW_MS);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function buildBarsQuery(params: {
  timeframe: string;
  limit?: number;
  start?: string;
  end?: string;
  feed?: string;
  adjustment?: string;
}) {
  const q = new URLSearchParams();
  q.set("timeframe", params.timeframe);
  q.set("feed", params.feed || ALPACA_FEED);
  if (params.limit != null) q.set("limit", String(params.limit));
  if (params.start) q.set("start", params.start);
  if (params.end) q.set("end", params.end);
  if (params.adjustment) q.set("adjustment", params.adjustment);
  return q.toString();
}

export async function fetchRecentBarsWithUrl(args: {
  ticker: string;
  timeframe: string;
  limit?: number;
  start?: string;
  end?: string;
  adjustment?: "raw" | "split" | "dividend" | "all";
  windowMinutes?: number;
}) {
  const ticker = args.ticker.toUpperCase();
  const endIso = args.end || new Date().toISOString();
  const defaultWindow =
    args.timeframe === "1Min"
      ? 90
      : args.timeframe === "5Min"
      ? 6 * 60
      : 24 * 60;
  const windowMinutes = args.windowMinutes ?? defaultWindow;
  const startIso =
    args.start ||
    new Date(Date.parse(endIso) - windowMinutes * 60 * 1000).toISOString();

  const params = buildBarsQuery({
    timeframe: args.timeframe,
    limit: args.limit,
    start: startIso,
    end: endIso,
    feed: ALPACA_FEED,
    adjustment: args.adjustment,
  });

  const url = dataUrl(`/stocks/${ticker}/bars?${params}`);

  const res = await fetch(url, {
    headers: alpacaHeaders(),
    cache: "no-store",
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Alpaca bars failed ${res.status}: ${text}`);
  }

  const json = await res.json();
  const bars: AlpacaBar[] =
    json?.bars?.[ticker] ||
    json?.bars ||
    json?.[ticker] ||
    [];
  const out = Array.isArray(bars) ? bars.slice() : [];
  out.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());

  return { url, bars: out, json };
}

export async function fetchRecentBars(
  symbol: string,
  timeframe: string,
  limit = 100,
  endTimeIso?: string
): Promise<AlpacaBar[]> {
  const { startIso, endIso } = computeBarsWindow(endTimeIso);
  const { bars } = await fetchRecentBarsWithUrl({
    ticker: symbol,
    timeframe,
    limit,
    start: startIso,
    end: endIso,
  });
  return bars;
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

  const res = await alpacaFetch(tradingUrl("/orders"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(text || "Order failed");

  return JSON.parse(text);
}

export async function createOrder(
  payload: Record<string, any>
): Promise<AlpacaOrder> {
  const res = await alpacaFetch(tradingUrl("/orders"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || "Failed to create order");
  }
  return res.json();
}

// ---------------- Trading helpers ----------------

export type AlpacaOrder = {
  id: string;
  client_order_id?: string;
  status?: string;
  [key: string]: any;
};

export async function getOrder(orderId: string): Promise<AlpacaOrder> {
  const res = await alpacaFetch(
    tradingUrl(`/orders/${encodeURIComponent(orderId)}?nested=true`),
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    }
  );
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
  const res = await alpacaFetch(
    tradingUrl(`/orders/${encodeURIComponent(orderId)}`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
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
  const res = await alpacaFetch(tradingUrl(path), {
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
    dataUrl(`/stocks/${encodeURIComponent(symbol)}/quotes/latest`),
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
