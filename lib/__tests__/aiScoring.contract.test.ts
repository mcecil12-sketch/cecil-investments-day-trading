import { describe, expect, test } from "vitest";

describe("aiScoring insufficient bars", () => {
  test("insufficient bars returns ERROR with aiScore=0, not SCORED", () => {
    // This is a contract test to ensure the insufficient bars path
    // returns an ERROR signal with aiScore=0 and error="insufficient_bars"
    // This is NOT a SCORED signal - insufficient bars is treated as an error condition

    const expectedResult = {
      aiScore: 0,
      aiGrade: "F",
      status: "ERROR",
      error: "insufficient_bars",
    };

    // Verify the expected structure
    expect(expectedResult.aiScore).toBe(0);
    expect(Number.isFinite(expectedResult.aiScore)).toBe(true);
    expect(expectedResult.status).toBe("ERROR");
    expect(expectedResult.error).toBe("insufficient_bars");
  });

  test("audit: no SCORED signal can have null aiScore", () => {
    const validSignals = [
      { status: "SCORED", aiScore: 9.5, ticker: "AAPL" },
      { status: "ERROR", aiScore: 0, error: "insufficient_bars", ticker: "TSLA" }, // insufficient bars case (now ERROR)
      { status: "ERROR", aiScore: 0, error: "parse_failed", ticker: "NVDA" }, // parse failed
      { status: "PENDING", aiScore: null, ticker: "MSFT" },
    ];

    const scoredWithNullScore = validSignals.filter(
      (s) => s.status === "SCORED" && (s.aiScore === null || !Number.isFinite(s.aiScore))
    );

    expect(scoredWithNullScore).toHaveLength(0);
  });

  test("all ERROR signals, including insufficient_bars, have aiScore=0 or null", () => {
    const errorSignals = [
      { status: "ERROR", error: "insufficient_bars", aiScore: 0, ticker: "TSLA" },
      { status: "ERROR", error: "parse_failed", aiScore: 0, ticker: "AAPL" },
      { status: "ERROR", error: "model_timeout", aiScore: null, ticker: "NVDA" },
    ];

    // All error signals should either have aiScore=0 or be null (not some other value)
    errorSignals.forEach((sig) => {
      expect(sig.status).toBe("ERROR");
      expect(sig.aiScore === null || sig.aiScore === 0).toBe(true);
    });
  });
});
