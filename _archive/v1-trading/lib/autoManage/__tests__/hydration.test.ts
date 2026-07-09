import { describe, expect, it } from "vitest";
import { hydrateOpenTradeFromBroker } from "@/lib/autoManage/hydration";

describe("hydrateOpenTradeFromBroker", () => {
  it("hydrates qty from broker when trade qty is missing", () => {
    const result = hydrateOpenTradeFromBroker(
      { ticker: "SPY", status: "OPEN", qty: null, entryPrice: 500 },
      { symbol: "SPY", qty: "12", avg_entry_price: "501.25" }
    );

    expect(result.qty).toBe(12);
    expect(result.qtyHydrated).toBe(true);
  });
});
