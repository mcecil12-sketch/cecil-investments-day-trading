import { describe, expect, it } from "vitest";
import { evaluateBreakerTransition } from "@/lib/autoEntry/breaker";

describe("evaluateBreakerTransition", () => {
  it("does not increment on SKIP market_closed", () => {
    const result = evaluateBreakerTransition({
      outcome: "SKIP",
      reason: "market_closed",
      consecutiveFailuresBefore: 2,
      maxConsecutiveFailures: 3,
    });

    expect(result.breakerAction).toBe("none");
    expect(result.consecutiveFailuresAfter).toBe(2);
    expect(result.shouldDisable).toBe(false);
  });

  it("does not increment on SKIP invalid_stop_vs_base_price", () => {
    const result = evaluateBreakerTransition({
      outcome: "SKIP",
      reason: "invalid_stop_vs_base_price",
      consecutiveFailuresBefore: 2,
      maxConsecutiveFailures: 3,
    });

    expect(result.breakerAction).toBe("none");
    expect(result.consecutiveFailuresAfter).toBe(2);
    expect(result.shouldDisable).toBe(false);
  });

  it("does not increment on any other SKIP reason", () => {
    const result = evaluateBreakerTransition({
      outcome: "SKIP",
      reason: "max_open_positions",
      consecutiveFailuresBefore: 2,
      maxConsecutiveFailures: 3,
    });

    expect(result.breakerAction).toBe("none");
    expect(result.consecutiveFailuresAfter).toBe(2);
    expect(result.shouldDisable).toBe(false);
  });

  it("increments on FAIL", () => {
    const result = evaluateBreakerTransition({
      outcome: "FAIL",
      reason: "execute_error",
      consecutiveFailuresBefore: 1,
      maxConsecutiveFailures: 3,
    });

    expect(result.breakerAction).toBe("increment");
    expect(result.consecutiveFailuresAfter).toBe(2);
    expect(result.shouldDisable).toBe(false);
  });

  it("resets on SUCCESS", () => {
    const result = evaluateBreakerTransition({
      outcome: "SUCCESS",
      reason: "placed",
      consecutiveFailuresBefore: 2,
      maxConsecutiveFailures: 3,
    });

    expect(result.breakerAction).toBe("reset");
    expect(result.consecutiveFailuresAfter).toBe(0);
    expect(result.clearAutoDisabled).toBe(true);
    expect(result.shouldDisable).toBe(false);
  });

  it("disables only after N FAILs, not after SKIPs", () => {
    const afterSkip = evaluateBreakerTransition({
      outcome: "SKIP",
      reason: "market_closed",
      consecutiveFailuresBefore: 2,
      maxConsecutiveFailures: 3,
    });
    expect(afterSkip.consecutiveFailuresAfter).toBe(2);
    expect(afterSkip.shouldDisable).toBe(false);

    const afterFail = evaluateBreakerTransition({
      outcome: "FAIL",
      reason: "execute_error",
      consecutiveFailuresBefore: afterSkip.consecutiveFailuresAfter,
      maxConsecutiveFailures: 3,
    });
    expect(afterFail.consecutiveFailuresAfter).toBe(3);
    expect(afterFail.shouldDisable).toBe(true);
  });
});
