const num = (v: any) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const validPositive = (v: any) => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

export function hydrateOpenTradeFromBroker(trade: any, brokerPos: any) {
  const currentQty = validPositive(trade?.quantity ?? trade?.qty ?? trade?.size ?? trade?.positionSize ?? trade?.shares);
  const brokerQtyRaw = validPositive((brokerPos as any)?.qty);
  const brokerQty = brokerQtyRaw != null ? Math.abs(brokerQtyRaw) : null;

  const currentEntry = validPositive(trade?.entryPrice);
  const brokerEntry = validPositive(
    (brokerPos as any)?.avg_entry_price ??
      (brokerPos as any)?.avgEntryPrice ??
      (brokerPos as any)?.avg_entry ??
      (brokerPos as any)?.cost_basis_per_share
  );

  const qtyHydrated = currentQty == null && brokerQty != null;
  const entryHydrated = currentEntry == null && brokerEntry != null;

  return {
    qty: qtyHydrated ? brokerQty : currentQty,
    entryPrice: entryHydrated ? brokerEntry : currentEntry,
    qtyHydrated,
    entryHydrated,
  };
}
