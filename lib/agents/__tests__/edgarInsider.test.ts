import { describe, expect, it, vi } from "vitest";
import {
  EDGAR_FIELD_MAP,
  EDGAR_MIN_INTERVAL_MS,
  SEC_TICKERS_URL,
  createEdgarClient,
  edgarUserAgent,
  fetchEdgarInsider,
  parseForm4Xml,
  parseTickerMap,
  rawXmlName,
  selectForm4Filings,
} from "@/lib/agents/edgarInsider";
import { summarizeInsiderActivity, type InsiderFetchResult } from "@/lib/agents/insiderActivity";
import { fetchInsiderWithFallback } from "@/lib/agents/insiderSources";
import { runInsiderPass } from "@/lib/agents/insiderEnrichment";

const ASOF = new Date("2026-10-12T12:00:00Z");
const FROM = new Date("2026-09-12T12:00:00Z");

function tx(over: { title?: string; date?: string; code?: string; shares?: string; price?: string; ad?: string } = {}) {
  const { title = "Common Stock", date = "2026-10-01", code = "S", shares = "100", price = "50.00", ad = code === "P" ? "A" : "D" } = over;
  return `<nonDerivativeTransaction>
    <securityTitle><value>${title}</value></securityTitle>
    <transactionDate><value>${date}</value></transactionDate>
    <transactionCoding><transactionFormTypeCode>4</transactionFormTypeCode><transactionCode>${code}</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
    <transactionAmounts>
      <transactionShares><value>${shares}</value></transactionShares>
      <transactionPricePerShare><value>${price}</value></transactionPricePerShare>
      <transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode>
    </transactionAmounts>
  </nonDerivativeTransaction>`;
}

function form4(txs: string[], opts: { planned?: "1" | "0" | null; owner?: string; officer?: string; derivative?: string } = {}) {
  const { planned = null, owner = "DOE JANE", officer = "Chief Financial Officer" } = opts;
  return `<?xml version="1.0"?><ownershipDocument><schemaVersion>X0508</schemaVersion><documentType>4</documentType>
    ${planned == null ? "" : `<aff10b5One>${planned}</aff10b5One>`}
    <reportingOwner><reportingOwnerId><rptOwnerCik>1</rptOwnerCik><rptOwnerName>${owner}</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer><officerTitle>${officer}</officerTitle></reportingOwnerRelationship></reportingOwner>
    <nonDerivativeTable>${txs.join("")}</nonDerivativeTable>
    <derivativeTable>${opts.derivative ?? ""}</derivativeTable>
  </ownershipDocument>`;
}

describe("parseForm4Xml", () => {
  it("extracts non-derivative transactions with owner, title, code, shares, price and the acquired/disposed flag", () => {
    const { rows, nonDerivativeRows } = parseForm4Xml(form4([tx({ code: "S", shares: "360", price: "898.0956" })]), "STX");
    expect(nonDerivativeRows).toBe(1);
    expect(rows).toEqual([
      expect.objectContaining({ ticker: "STX", executive: "DOE JANE", executive_title: "Chief Financial Officer", security_type: "Common Stock", acquisition_or_disposal: "S", acquired_disposed: "D", shares: "360", share_price: "898.0956", transaction_date: "2026-10-01" }),
    ]);
  });

  it("ignores the derivative table entirely (options/RSUs)", () => {
    const derivative = `<derivativeTransaction><securityTitle><value>Stock Option</value></securityTitle><transactionDate><value>2026-10-01</value></transactionDate><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>999</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></derivativeTransaction>`;
    const { rows } = parseForm4Xml(form4([tx()], { derivative }), "X");
    expect(rows).toHaveLength(1);
    expect(summarizeInsiderActivity(rows, ASOF, EDGAR_FIELD_MAP).insiderNetSoldUsd30d).toBe(5000);
  });

  it("drops non-common non-derivative rows (preferred, notes) and malformed code/flag pairs", () => {
    const { rows, nonDerivativeRows } = parseForm4Xml(
      form4([tx({ title: "Series A Preferred Stock" }), tx({ title: "Senior Notes" }), tx({ code: "S", ad: "A" }), tx({ title: "Class A Common Stock" }), tx({ title: "Ordinary Shares" })]),
      "X",
    );
    expect(nonDerivativeRows).toBe(5);
    expect(rows.map((r) => r.security_type)).toEqual(["Class A Common Stock", "Ordinary Shares"]);
  });

  it("carries the Rule 10b5-1 indicator when the filing has one, and omits it for older forms", () => {
    expect(parseForm4Xml(form4([tx()], { planned: "1" }), "X").rows[0].is_10b5_1).toBe(true);
    expect(parseForm4Xml(form4([tx()], { planned: "0" }), "X").rows[0].is_10b5_1).toBe(false);
    expect("is_10b5_1" in parseForm4Xml(form4([tx()]), "X").rows[0]).toBe(false);
  });

  it("throws on a body that is not a Form 4 (so the ticker FAILS, never reads as zero)", () => {
    expect(() => parseForm4Xml("<html>Request blocked</html>", "X")).toThrow(/not a Form 4/);
  });
});

describe("summarizing EDGAR rows: same rule as today (S/P, common, positive price)", () => {
  it("counts only S and P at a positive price; M/F/A/G excluded; planned sales split out", () => {
    const rows = [
      ...parseForm4Xml(form4([tx({ code: "S", shares: "100", price: "50" }), tx({ code: "M", shares: "5000", price: "10", ad: "A" }), tx({ code: "F", shares: "40", price: "50", ad: "D" }), tx({ code: "G", shares: "10", price: "0", ad: "D" })], { planned: "1" }), "X").rows,
      ...parseForm4Xml(form4([tx({ code: "S", shares: "20", price: "50" }), tx({ code: "P", shares: "10", price: "50" }), tx({ code: "S", shares: "5", price: "0" })], { planned: "0", owner: "ROE RICK" }), "X").rows,
    ];
    const s = summarizeInsiderActivity(rows, ASOF, EDGAR_FIELD_MAP);
    expect(s.insiderNetSoldUsd30d).toBe(5000 + 1000 - 500);
    expect(s.insiderSaleCount30d).toBe(2);
    expect(s.insiderSellers30d).toBe(2);
    expect(s.plannedSalesUsd).toBe(5000);
    expect(s.insiderHas10b5_1).toBe(true);
  });

  it("plannedSalesUsd is null when no row carries the indicator", () => {
    const s = summarizeInsiderActivity(parseForm4Xml(form4([tx()]), "X").rows, ASOF, EDGAR_FIELD_MAP);
    expect(s.plannedSalesUsd).toBeNull();
    expect(s.insiderHas10b5_1).toBeNull();
  });
});

describe("filing selection and ticker map", () => {
  it("keeps only form 4 filed in the window, newest first, and addresses the raw xml, not the xsl rendering", () => {
    const recent = {
      form: ["4", "10-Q", "4", "4", "4/A"],
      filingDate: ["2026-10-02", "2026-10-01", "2026-09-20", "2026-08-01", "2026-10-03"],
      accessionNumber: ["0001-26-000001", "0001-26-000002", "0001-26-000003", "0001-26-000004", "0001-26-000005"],
      primaryDocument: ["xslF345X05/a.xml", "q.htm", "b.xml", "c.xml", "d.xml"],
    };
    const sel = selectForm4Filings({ filings: { recent } }, FROM);
    expect(sel).toEqual([
      { accession: "0001-26-000001", file: "a.xml", filingDate: "2026-10-02" },
      { accession: "0001-26-000003", file: "b.xml", filingDate: "2026-09-20" },
    ]);
    expect(rawXmlName("xslF345X05/wf-form4_1.xml")).toBe("wf-form4_1.xml");
    expect(() => selectForm4Filings({}, FROM)).toThrow(/no filings.recent/);
  });

  it("parses company_tickers.json into zero-padded CIKs", () => {
    const m = parseTickerMap({ "0": { cik_str: 1137789, ticker: "stx", title: "Seagate" }, "1": { cik_str: "1045810", ticker: "NVDA" }, "2": { junk: true } });
    expect(m.get("STX")).toBe("0001137789");
    expect(m.get("NVDA")).toBe("0001045810");
    expect(m.size).toBe(2);
  });
});

/** A scripted fake SEC: path substring -> response. Records every request. */
function fakeSec(routes: Record<string, () => { status: number; body: string }>) {
  const calls: Array<{ url: string; ua: string | null }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, ua: new Headers(init?.headers).get("User-Agent") });
    const key = Object.keys(routes).reverse().find((k) => u.includes(k)); // later (override) routes win
    if (!key) return new Response("not found", { status: 404 });
    const r = routes[key]();
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), sleeps, advance: (ms: number) => void (t += ms) };
}

const TICKERS = JSON.stringify({ "0": { cik_str: 1137789, ticker: "STX", title: "Seagate" } });
const subs = (n: number) =>
  JSON.stringify({
    filings: { recent: { form: Array(n).fill("4"), filingDate: Array(n).fill("2026-10-02"), accessionNumber: Array.from({ length: n }, (_, i) => `0001137789-26-00000${i}`), primaryDocument: Array(n).fill("xslF345X05/f.xml") } },
  });

function happyRoutes(extra: Record<string, () => { status: number; body: string }> = {}) {
  return {
    "company_tickers.json": () => ({ status: 200, body: TICKERS }),
    "submissions/CIK0001137789.json": () => ({ status: 200, body: subs(2) }),
    "/Archives/edgar/data/1137789/": () => ({ status: 200, body: form4([tx({ code: "S", shares: "100", price: "50" })]) }),
    ...extra,
  };
}

describe("EDGAR client: fair-access rules", () => {
  it("sends a descriptive User-Agent with the configured contact, never a hardcoded address", async () => {
    const { fetchFn, calls } = fakeSec(happyRoutes());
    const clock = fakeClock();
    const client = createEdgarClient({ fetchFn, ...clock, contactEmail: "ops@example.test" });
    const res = await fetchEdgarInsider(client, "STX", FROM, { now: clock.now });
    expect(res.ok).toBe(true);
    expect(calls.every((c) => c.ua === edgarUserAgent("ops@example.test"))).toBe(true);
    expect(calls.every((c) => c.ua!.includes("ops@example.test"))).toBe(true);
  });

  it("is a failure (not zero) when no contact email is configured, and makes no request", async () => {
    const { fetchFn, calls } = fakeSec(happyRoutes());
    const client = createEdgarClient({ fetchFn, contactEmail: null });
    const res = await fetchEdgarInsider(client, "STX", FROM);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("SEC_CONTACT_EMAIL") });
    expect(calls).toHaveLength(0);
  });

  it("never exceeds 5 requests/second: consecutive requests are spaced >= the minimum interval", async () => {
    const { fetchFn } = fakeSec(happyRoutes({ "submissions/CIK0001137789.json": () => ({ status: 200, body: subs(6) }) }));
    const times: number[] = [];
    const clock = fakeClock();
    const timed = ((u: string, i?: RequestInit) => (times.push(clock.now()), (fetchFn as unknown as (u: string, i?: RequestInit) => Promise<Response>)(u, i))) as unknown as typeof fetch;
    const client = createEdgarClient({ fetchFn: timed, ...clock, contactEmail: "ops@example.test" });
    const res = await fetchEdgarInsider(client, "STX", FROM, { now: clock.now });
    expect(res.ok).toBe(true);
    expect(times.length).toBe(1 + 1 + 6); // tickers + submissions + 6 filings
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(EDGAR_MIN_INTERVAL_MS);
    expect(EDGAR_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(200);
  });

  it("treats any non-200 as FAILED, never zero rows", async () => {
    for (const status of [404, 500, 503]) {
      const { fetchFn } = fakeSec(happyRoutes({ "submissions/": () => ({ status, body: "x" }) }));
      const clock = fakeClock();
      const res = await fetchEdgarInsider(createEdgarClient({ fetchFn, ...clock, contactEmail: "a@b.test" }), "STX", FROM);
      expect(res).toMatchObject({ ok: false, reason: expect.stringContaining(`HTTP ${status}`) });
    }
  });

  it("an unparseable filing body fails the ticker", async () => {
    const { fetchFn } = fakeSec(happyRoutes({ "/Archives/": () => ({ status: 200, body: "<html>Blocked by SEC</html>" }) }));
    const clock = fakeClock();
    const res = await fetchEdgarInsider(createEdgarClient({ fetchFn, ...clock, contactEmail: "a@b.test" }), "STX", FROM);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("not a Form 4") });
  });

  it("backs off on 429, retries, and succeeds; gives up after the backoffs", async () => {
    let hits = 0;
    const { fetchFn } = fakeSec(happyRoutes({ "submissions/": () => (++hits === 1 ? { status: 429, body: "slow down" } : { status: 200, body: subs(1) }) }));
    const clock = fakeClock();
    const client = createEdgarClient({ fetchFn, ...clock, contactEmail: "a@b.test" });
    const res = await fetchEdgarInsider(client, "STX", FROM, { now: clock.now });
    expect(res.ok).toBe(true);
    expect(client.stats.backoffs).toBe(1);
    expect(clock.sleeps.some((ms) => ms >= 2000)).toBe(true);

    const blocked = fakeSec(happyRoutes({ "submissions/": () => ({ status: 403, body: "denied" }) }));
    const c2 = fakeClock();
    const res2 = await fetchEdgarInsider(createEdgarClient({ fetchFn: blocked.fetchFn, ...c2, contactEmail: "a@b.test" }), "STX", FROM);
    expect(res2).toMatchObject({ ok: false, reason: expect.stringContaining("throttled") });
  });

  it("caches the ticker map (one company_tickers.json fetch for many tickers) and fails an unknown ticker", async () => {
    const { fetchFn, calls } = fakeSec(happyRoutes());
    const clock = fakeClock();
    const client = createEdgarClient({ fetchFn, ...clock, contactEmail: "a@b.test" });
    await fetchEdgarInsider(client, "STX", FROM, { now: clock.now });
    const unknown = await fetchEdgarInsider(client, "ZZZZ", FROM, { now: clock.now });
    expect(unknown).toMatchObject({ ok: false, reason: expect.stringContaining("not in SEC company_tickers.json") });
    expect(calls.filter((c) => c.url === SEC_TICKERS_URL)).toHaveLength(1);
    clock.advance(8 * 24 * 60 * 60 * 1000); // past the weekly TTL
    await fetchEdgarInsider(client, "STX", FROM, { now: clock.now });
    expect(calls.filter((c) => c.url === SEC_TICKERS_URL)).toHaveLength(2);
  });

  it("returns the rows normalized for the summarizer, with the source tag and request count", async () => {
    const { fetchFn } = fakeSec(happyRoutes());
    const clock = fakeClock();
    const res = await fetchEdgarInsider(createEdgarClient({ fetchFn, ...clock, contactEmail: "a@b.test" }), "STX", FROM, { now: clock.now });
    expect(res).toMatchObject({ ok: true, source: "edgar", meta: { filings: 2, requests: 4 } });
    if (res.ok) expect(summarizeInsiderActivity(res.rows, ASOF, res.fields).insiderNetSoldUsd30d).toBe(10000);
  });

  it("aborts cleanly (no failure, no partial rows) when the deadline passes mid-ticker", async () => {
    const { fetchFn } = fakeSec(happyRoutes({ "submissions/": () => ({ status: 200, body: subs(5) }) }));
    const clock = fakeClock();
    const client = createEdgarClient({ fetchFn, ...clock, contactEmail: "a@b.test" });
    const res = await fetchEdgarInsider(client, "STX", FROM, { now: clock.now, deadlineAtMs: clock.now() + 600 });
    expect(res).toMatchObject({ ok: false, aborted: true });
  });
});

describe("EDGAR primary, Alpha Vantage fallback", () => {
  const okEdgar = (rows: Array<Record<string, unknown>>): InsiderFetchResult => ({ ok: true, rows, responseKeys: ["submissions"], source: "edgar", fields: EDGAR_FIELD_MAP, meta: { requests: 3, filings: 1 } });
  const edgarClientReturning = (res: InsiderFetchResult) => ({ res });

  async function withEdgar(res: "ok" | "fail" | "empty" | "abort", av: InsiderFetchResult) {
    const { fetchFn } = fakeSec(
      res === "fail"
        ? happyRoutes({ "submissions/": () => ({ status: 500, body: "x" }) })
        : res === "empty"
          ? happyRoutes({ "submissions/": () => ({ status: 200, body: subs(0) }) })
          : happyRoutes(),
    );
    const clock = fakeClock();
    const client = createEdgarClient({ fetchFn, ...clock, contactEmail: "a@b.test" });
    const alphaVantage = vi.fn(async () => av);
    const result = await fetchInsiderWithFallback("STX", FROM, { client, now: clock.now, alphaVantage, deadlineAtMs: res === "abort" ? clock.now() + 300 : undefined });
    return { result, alphaVantage };
  }
  void edgarClientReturning;
  void okEdgar;

  const avOk: InsiderFetchResult = { ok: true, rows: [{ transaction_date: "2026-10-01", executive: "A", security_type: "Ordinary Shares", acquisition_or_disposal: "S", shares: "1", share_price: "1" }], responseKeys: ["data"], source: "alphavantage" };
  const avFail: InsiderFetchResult = { ok: false, reason: "Information: premium", responseKeys: ["Information"] };

  it("uses EDGAR when it works and never touches Alpha Vantage", async () => {
    const { result, alphaVantage } = await withEdgar("ok", avOk);
    expect(result).toMatchObject({ ok: true, source: "edgar" });
    expect(alphaVantage).not.toHaveBeenCalled();
  });

  it("a valid EMPTY EDGAR result stays EDGAR's answer (n/a), with no fallback", async () => {
    const { result, alphaVantage } = await withEdgar("empty", avOk);
    expect(result).toMatchObject({ ok: true, source: "edgar", rows: [] });
    expect(alphaVantage).not.toHaveBeenCalled();
  });

  it("falls back to Alpha Vantage per ticker when EDGAR fails, tagging the source and keeping EDGAR's reason", async () => {
    const { result, alphaVantage } = await withEdgar("fail", avOk);
    expect(alphaVantage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, source: "alphavantage", meta: { edgarFailure: expect.stringContaining("HTTP 500") } });
  });

  it("FAILED when both fail, carrying both reasons", async () => {
    const { result } = await withEdgar("fail", avFail);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/EDGAR: .*HTTP 500.*Alpha Vantage: Information: premium/) });
  });

  it("an EDGAR time-budget abort is not a failure and does not fall back", async () => {
    const { result, alphaVantage } = await withEdgar("abort", avOk);
    expect(result).toMatchObject({ ok: false, aborted: true });
    expect(alphaVantage).not.toHaveBeenCalled();
  });
});

describe("insider pass with sources", () => {
  const sale = [{ transaction_date: "2026-10-05", executive: "A", security_type: "Common Stock", acquisition_or_disposal: "S", shares: "10", share_price: "5", is_10b5_1: true }];
  const clockless = { now: () => 0, sleep: async () => {} };

  it("records the source per ticker, counts requests/sources, and skips Alpha Vantage pacing after an EDGAR result", async () => {
    const sleeps: number[] = [];
    const sources = ["edgar", "edgar", "alphavantage"] as const;
    let i = 0;
    const seen: Array<{ symbol: string; source: string | null }> = [];
    const result = await runInsiderPass(
      [{ id: "1", symbol: "A" }, { id: "2", symbol: "B" }, { id: "3", symbol: "C" }, { id: "4", symbol: "D" }],
      {
        ...clockless,
        sleep: async (ms) => void sleeps.push(ms),
        fetchRows: async (symbol) =>
          symbol === "D"
            ? { ok: false, reason: "EDGAR: x; Alpha Vantage: y", responseKeys: [], meta: { requests: 2 } }
            : { ok: true, rows: sale, responseKeys: [], source: sources[i++], fields: EDGAR_FIELD_MAP, meta: { requests: 3, filings: 2 } },
        onResult: async (item, _s, meta) => void seen.push({ symbol: item.symbol, source: meta.source }),
      },
    );
    expect(seen).toEqual([{ symbol: "A", source: "edgar" }, { symbol: "B", source: "edgar" }, { symbol: "C", source: "alphavantage" }, { symbol: "D", source: null }]);
    expect(result.insiderFromEdgar).toBe(2);
    expect(result.insiderFromAlphaVantage).toBe(1);
    expect(result.insiderFailed).toBe(1);
    expect(result.insiderRequests).toBe(3 + 3 + 3 + 2);
    // pacing only before the ticker that follows a non-EDGAR result (C->D), none after EDGAR results
    expect(sleeps).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ source: "edgar", filings: 2, plannedSalesUsd: 50, status: "ok" });
    expect(result.diagnostics[3]).toMatchObject({ status: "failed", source: null });
  });

  it("an EDGAR abort stops the pass, leaves the rest unattempted, and is not counted as an attempt", async () => {
    let n = 0;
    const result = await runInsiderPass([{ id: "1", symbol: "A" }, { id: "2", symbol: "B" }, { id: "3", symbol: "C" }], {
      ...clockless,
      fetchRows: async () => (++n === 2 ? { ok: false, reason: "time budget reached mid-ticker", responseKeys: [], aborted: true } : { ok: true, rows: sale, responseKeys: [], source: "edgar", fields: EDGAR_FIELD_MAP }),
    });
    expect(result.insiderCallsUsed).toBe(1);
    expect(result.insiderSkippedByDeadline).toBe(2);
    expect(result.deadlineHit).toBe(true);
    expect(result.diagnostics).toHaveLength(1);
  });
});
