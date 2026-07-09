import type { AutoEntryOutcome } from "@/lib/autoEntry/telemetry";

export type BreakerAction = "increment" | "reset" | "none";

export type BreakerTransition = {
  consecutiveFailuresBefore: number;
  consecutiveFailuresAfter: number;
  breakerAction: BreakerAction;
  breakerReason: string;
  shouldDisable: boolean;
  clearAutoDisabled: boolean;
};

export function evaluateBreakerTransition(args: {
  outcome: AutoEntryOutcome;
  reason: string;
  consecutiveFailuresBefore: number;
  maxConsecutiveFailures: number;
}): BreakerTransition {
  const before = Math.max(0, Math.floor(Number(args.consecutiveFailuresBefore) || 0));
  const max = Math.max(1, Math.floor(Number(args.maxConsecutiveFailures) || 1));
  const reason = String(args.reason || "unknown");

  if (args.outcome === "FAIL") {
    const after = before + 1;
    return {
      consecutiveFailuresBefore: before,
      consecutiveFailuresAfter: after,
      breakerAction: "increment",
      breakerReason: reason,
      shouldDisable: after >= max,
      clearAutoDisabled: false,
    };
  }

  if (args.outcome === "SUCCESS") {
    return {
      consecutiveFailuresBefore: before,
      consecutiveFailuresAfter: 0,
      breakerAction: "reset",
      breakerReason: reason,
      shouldDisable: false,
      clearAutoDisabled: true,
    };
  }

  return {
    consecutiveFailuresBefore: before,
    consecutiveFailuresAfter: before,
    breakerAction: "none",
    breakerReason: reason,
    shouldDisable: false,
    clearAutoDisabled: false,
  };
}
