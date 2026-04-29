export type AutoEntryFunnelOutcome = {
  outcome: "SUCCESS" | "SKIP" | "FAIL";
  reason: string;
  side?: "LONG" | "SHORT"; // Phase 3: Direction-aware tracking
};

export type AutoEntryFunnelFields = {
  autoEntryPlaced?: number;
  autoEntrySkipMarketClosed?: number;
  autoEntrySkipNoPending?: number;
  autoEntrySkipMaxOpen?: number;
  autoEntrySkipOther?: number;
  // Phase 3: Direction-aware attribution
  executeFromSeededLong?: number;
  executeFromSeededShort?: number;
  executeSkippedPriceDrift?: number;
  executeSkippedLiquidity?: number;
  executeSkippedBracketInvalid?: number;
  executeSkippedOther?: number;
  // Execute archive attribution
  executeArchivedDrifted?: number;
  executeArchivedNoLongerEligible?: number;
};

export function buildAutoEntryFunnelFields(params: AutoEntryFunnelOutcome): AutoEntryFunnelFields {
  const reason = String(params.reason || "");
  const fields: AutoEntryFunnelFields = {};

  if (params.outcome === "SUCCESS" && reason === "placed") {
    fields.autoEntryPlaced = 1;
    // Phase 3: Track by direction
    if (params.side === "LONG") {
      fields.executeFromSeededLong = 1;
    } else if (params.side === "SHORT") {
      fields.executeFromSeededShort = 1;
    }
    return fields;
  }

  if (params.outcome === "SKIP") {
    if (reason === "market_closed") return { autoEntrySkipMarketClosed: 1 };
    if (reason === "no_AUTO_PENDING") return { autoEntrySkipNoPending: 1 };
    if (reason === "max_open_positions") return { autoEntrySkipMaxOpen: 1 };

    // Phase 3: Detailed skip reasons
    if (reason.includes("price_drift") || reason.includes("drift")) {
      return { autoEntrySkipOther: 1, executeSkippedPriceDrift: 1 };
    }
    if (reason.includes("liquidity") || reason.includes("volume")) {
      return { autoEntrySkipOther: 1, executeSkippedLiquidity: 1 };
    }
    if (reason.includes("bracket") || reason.includes("stop") || reason.includes("invalid")) {
      return { autoEntrySkipOther: 1, executeSkippedBracketInvalid: 1 };
    }
    return { autoEntrySkipOther: 1, executeSkippedOther: 1 };
  }

  // FAIL outcomes also get detailed tracking
  if (params.outcome === "FAIL") {
    if (reason.includes("price_drift") || reason.includes("drift")) {
      return { executeSkippedPriceDrift: 1 };
    }
    if (reason.includes("liquidity") || reason.includes("volume")) {
      return { executeSkippedLiquidity: 1 };
    }
    if (reason.includes("bracket") || reason.includes("stop") || reason.includes("invalid")) {
      return { executeSkippedBracketInvalid: 1 };
    }
    return { executeSkippedOther: 1 };
  }

  return fields;
}
