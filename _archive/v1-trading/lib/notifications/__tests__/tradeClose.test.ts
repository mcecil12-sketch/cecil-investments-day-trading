import { describe, it, expect } from "vitest";
import {
  formatSignedDollars,
  formatSignedR,
  buildTradeClosedPayload,
} from "../tradeClose";

describe("formatSignedDollars", () => {
  it("formats positive amounts with + sign", () => {
    expect(formatSignedDollars(123.45)).toBe("+$123.45");
    expect(formatSignedDollars(0.01)).toBe("+$0.01");
  });

  it("formats negative amounts with - sign", () => {
    expect(formatSignedDollars(-183.22)).toBe("-$183.22");
    expect(formatSignedDollars(-0.50)).toBe("-$0.50");
  });

  it("formats zero without sign", () => {
    expect(formatSignedDollars(0)).toBe("$0.00");
    expect(formatSignedDollars(-0)).toBe("$0.00");
  });

  it("handles null/undefined", () => {
    expect(formatSignedDollars(null)).toBe("$0.00");
    expect(formatSignedDollars(undefined)).toBe("$0.00");
  });

  it("handles non-finite values", () => {
    expect(formatSignedDollars(NaN)).toBe("$0.00");
    expect(formatSignedDollars(Infinity)).toBe("$0.00");
  });
});

describe("formatSignedR", () => {
  it("formats positive R with + sign", () => {
    expect(formatSignedR(1.25)).toBe("+1.25R");
    expect(formatSignedR(2.5)).toBe("+2.50R");
  });

  it("formats negative R with - sign", () => {
    expect(formatSignedR(-0.52)).toBe("-0.52R");
    expect(formatSignedR(-1.0)).toBe("-1.00R");
  });

  it("formats zero without sign", () => {
    expect(formatSignedR(0)).toBe("0.00R");
    expect(formatSignedR(-0)).toBe("0.00R");
  });

  it("handles null/undefined", () => {
    expect(formatSignedR(null)).toBe("0.00R");
    expect(formatSignedR(undefined)).toBe("0.00R");
  });
});

describe("buildTradeClosedPayload", () => {
  it("builds complete payload with all fields", () => {
    const trade = {
      ticker: "AAPL",
      closeReason: "stop_hit",
      realizedR: -0.52,
      realizedPnL: -183.22,
      entryPrice: 150.0,
      closePrice: 148.0,
    };

    const payload = buildTradeClosedPayload(trade);

    expect(payload.title).toBe("SOLD: AAPL (stop_hit)");
    expect(payload.message).toBe(
      "AAPL | closed -0.52R | -$183.22 | entry $150.00 → exit $148.00"
    );
  });

  it("builds payload with positive R and PnL", () => {
    const trade = {
      ticker: "GOOGL",
      closeReason: "target_hit",
      realizedR: 2.5,
      realizedPnL: 450.75,
      entryPrice: 2800.0,
      closePrice: 2900.0,
    };

    const payload = buildTradeClosedPayload(trade);

    expect(payload.title).toBe("SOLD: GOOGL (target_hit)");
    expect(payload.message).toBe(
      "GOOGL | closed +2.50R | +$450.75 | entry $2800.00 → exit $2900.00"
    );
  });

  it("handles missing R and PnL", () => {
    const trade = {
      ticker: "MSFT",
      closeReason: "manual",
      entryPrice: 300.0,
      closePrice: 305.0,
    };

    const payload = buildTradeClosedPayload(trade);

    expect(payload.title).toBe("SOLD: MSFT (manual)");
    expect(payload.message).toBe("MSFT | entry $300.00 → exit $305.00");
  });

  it("handles missing prices", () => {
    const trade = {
      ticker: "TSLA",
      closeReason: "stop_hit",
      realizedR: -1.0,
      realizedPnL: -250.0,
    };

    const payload = buildTradeClosedPayload(trade);

    expect(payload.title).toBe("SOLD: TSLA (stop_hit)");
    expect(payload.message).toBe("TSLA | closed -1.00R | -$250.00");
  });

  it("handles ticker and closeReason only", () => {
    const trade = {
      ticker: "NVDA",
      closeReason: "timeout",
    };

    const payload = buildTradeClosedPayload(trade);

    expect(payload.title).toBe("SOLD: NVDA (timeout)");
    expect(payload.message).toBe("NVDA");
  });

  it("handles missing ticker and closeReason", () => {
    const trade = {};

    const payload = buildTradeClosedPayload(trade);

    expect(payload.title).toBe("SOLD: UNKNOWN (unknown)");
    expect(payload.message).toBe("UNKNOWN");
  });
});
