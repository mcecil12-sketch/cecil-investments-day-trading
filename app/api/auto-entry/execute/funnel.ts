export type AutoEntryFunnelOutcome = {
  outcome: "SUCCESS" | "SKIP" | "FAIL";
  reason: string;
};

export type AutoEntryFunnelFields = {
  autoEntryPlaced?: number;
  autoEntrySkipMarketClosed?: number;
  autoEntrySkipNoPending?: number;
  autoEntrySkipMaxOpen?: number;
  autoEntrySkipOther?: number;
};

export function buildAutoEntryFunnelFields(params: AutoEntryFunnelOutcome): AutoEntryFunnelFields {
  const reason = String(params.reason || "");
  if (params.outcome === "SUCCESS" && reason === "placed") {
    return { autoEntryPlaced: 1 };
  }
  if (params.outcome === "SKIP") {
    if (reason === "market_closed") return { autoEntrySkipMarketClosed: 1 };
    if (reason === "no_AUTO_PENDING") return { autoEntrySkipNoPending: 1 };
    if (reason === "max_open_positions") return { autoEntrySkipMaxOpen: 1 };
    return { autoEntrySkipOther: 1 };
  }
  return {};
}
