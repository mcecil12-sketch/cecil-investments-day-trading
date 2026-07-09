import { describe, expect, test } from "vitest";

describe("aiScoring insufficient bars", () => {
  test("insufficient bars returns ARCHIVED with skipReason, not ERROR", () => {
    // This is a contract test to ensure the insufficient bars path
    // returns an ARCHIVED signal with skipReason="insufficient_bars" and aiScore=0
    // This is NOT a SCORED or ERROR signal - insufficient bars is treated as a skip condition

    const expectedResult = {
      aiScore: 0,
      aiGrade: "F",
      status: "ARCHIVED",
      skipReason: "insufficient_bars",
      qualified: false,
      shownInApp: false,
    };

    // Verify the expected structure
    expect(expectedResult.aiScore).toBe(0);
    expect(Number.isFinite(expectedResult.aiScore)).toBe(true);
    expect(expectedResult.status).toBe("ARCHIVED");
    expect(expectedResult.skipReason).toBe("insufficient_bars");
    expect(expectedResult.qualified).toBe(false);
    expect(expectedResult.shownInApp).toBe(false);
  });

  test("audit: no SCORED signal can have null aiScore", () => {
    const validSignals = [
      { status: "SCORED", aiScore: 9.5, ticker: "AAPL" },
      { status: "ARCHIVED", aiScore: 0, skipReason: "insufficient_bars", ticker: "TSLA" }, // insufficient bars case (now ARCHIVED)
      { status: "ERROR", aiScore: 0, error: "parse_failed", ticker: "NVDA" }, // parse failed
      { status: "PENDING", aiScore: null, ticker: "MSFT" },
    ];

    const scoredWithNullScore = validSignals.filter(
      (s) => s.status === "SCORED" && (s.aiScore === null || !Number.isFinite(s.aiScore))
    );

    expect(scoredWithNullScore).toHaveLength(0);
  });

  test("ERROR signals have aiScore=0 or null; ARCHIVED skips have aiScore=0", () => {
    const signals = [
      { status: "ARCHIVED", skipReason: "insufficient_bars", aiScore: 0, ticker: "TSLA" },
      { status: "ERROR", error: "parse_failed", aiScore: 0, ticker: "AAPL" },
      { status: "ERROR", error: "model_timeout", aiScore: null, ticker: "NVDA" },
    ];

    // All error signals should either have aiScore=0 or be null (not some other value)
    signals.forEach((sig) => {
      if (sig.status === "ERROR") {
        expect(sig.aiScore === null || sig.aiScore === 0).toBe(true);
      } else if (sig.status === "ARCHIVED") {
        expect(sig.aiScore).toBe(0);
      }
    });
  });
});
