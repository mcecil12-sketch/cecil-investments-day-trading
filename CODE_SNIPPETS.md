# Quick Reference: Key Normalization Snippets

## 1. lib/autoManage/stopSync.ts (~line 110)
```typescript
// Before: nextStopPrice direct to createOrder
// After:
const tick = tickForEquityPrice(entryPrice);
const normResult = normalizeStopPrice({
  side,
  entryPrice,
  stopPrice: nextStopPrice,
  tick,
});

if (!normResult.ok) {
  return {
    ok: false,
    error: "stop_normalization_failed",
    detail: `reason=${normResult.reason} original=${nextStopPrice} normalized=${normResult.stop || "N/A"}`,
  };
}

const stopOrder = await createOrder({
  // ... other fields ...
  stop_price: normResult.stop,  // ← Quantized value
});
```

---

## 2. app/api/trades/apply-stop/route.ts (~line 103)
```typescript
// Before: stopPrice direct to createOrder, no validation
// After:
const entryPrice = Number(trade.entryPrice ?? 0);
const tick = tickForEquityPrice(entryPrice);
const normResult = normalizeStopPrice({
  side: side as "LONG" | "SHORT",
  entryPrice,
  stopPrice,
  tick,
});

if (!normResult.ok) {
  return NextResponse.json(
    {
      ok: false,
      error: "stop_price_normalization_failed",
      reason: normResult.reason,
      original: stopPrice,
      normalized: normResult.stop,
    },
    { status: 400 }
  );
}

const stopOrder = await createOrder({
  // ... other fields ...
  stop_price: normResult.stop,  // ← Quantized value
});

const updatedTrade = {
  ...trade,
  stopPrice: normResult.stop,  // ← Store normalized
  // ... other fields ...
};
```

---

## 3. app/api/trades/manage/route.ts (~line 108 & ~line 240)
```typescript
// autoApplyStop function (before submission):
const entryPrice = Number(trade.entryPrice ?? 0);
const tick = tickForEquityPrice(entryPrice);
const normResult = normalizeStopPrice({
  side: (trade.side?.toUpperCase() as "LONG" | "SHORT") || "LONG",
  entryPrice,
  stopPrice: newStop,
  tick,
});

if (!normResult.ok) {
  throw new Error(
    `Cannot apply stop: normalization failed (${normResult.reason}) for ${newStop}`
  );
}

newStop = normResult.stop;
await replaceOrder(stopLeg.id, { stop_price: newStop });

// ───────────────────────────────────────────────────────────

// Stop suggestion computation (normalize before storing):
if (unrealizedR != null && unrealizedR >= 1) {
  suggestedStopPrice = entry;
  
  const tick = tickForEquityPrice(entry);
  const normBE = normalizeStopPrice({
    side: (t.side?.toUpperCase() as "LONG" | "SHORT") || "LONG",
    entryPrice: entry,
    stopPrice: suggestedStopPrice,
    tick,
  });
  if (normBE.ok) suggestedStopPrice = normBE.stop;  // ← Use normalized
}

if (unrealizedR != null && unrealizedR >= 2 && oneRVal > 0) {
  const lockInRaw = t.side.toUpperCase() === "LONG"
    ? entry + oneRVal / t.size
    : entry - oneRVal / t.size;
  
  const tick = tickForEquityPrice(entry);
  const normLock = normalizeStopPrice({
    side: (t.side?.toUpperCase() as "LONG" | "SHORT") || "LONG",
    entryPrice: entry,
    stopPrice: lockInRaw,
    tick,
  });
  suggestedStopPrice = normLock.ok ? normLock.stop : lockInRaw;  // ← Use normalized
}
```

---

## 4. lib/autoEntry/pricing.ts (~line 130)
```typescript
// In computeBracket() - FINAL pass after all existing logic:

const clamped = clampBracketPrices({
  side,
  basePrice: entryPrice,
  takeProfitPrice,
  stopPrice,
});
takeProfitPrice = clamped.takeProfitPrice;
stopPrice = clamped.stopPrice;

// ← NEW FINAL NORMALIZATION PASS
const tick = tickForEquityPrice(entryPrice);
const stopNorm = normalizeStopPrice({
  side,
  entryPrice,
  stopPrice,
  tick,
});
if (stopNorm.ok) {
  stopPrice = stopNorm.stop;
}

const tpNorm = normalizeLimitPrice({
  price: takeProfitPrice,
  tick,
});
takeProfitPrice = tpNorm;

return { entryPrice, stopPrice, takeProfitPrice };
```

---

## 5. app/api/auto-entry/execute/route.ts (~line 728)
```typescript
// In async lock function - BEFORE order submission:

const bracketCheck = validateAndRepairBracket({
  side: sideDirection === "buy" ? "LONG" : "SHORT",
  basePrice: entryPrice,
  takeProfitPrice: tp,
  stopPrice: bracketStop,
});

if (!bracketCheck.valid) {
  return { __poison: true, message: `bracket_validation_failed: ${bracketCheck.reason || "unknown"}` } as any;
}

let finalTp = bracketCheck.tp;
let finalStop = bracketCheck.stop;

// ← NEW FINAL TICK NORMALIZATION
const tick = tickForEquityPrice(entryPrice);
const stopNorm = normalizeStopPrice({
  side: sideDirection === "buy" ? "LONG" : "SHORT",
  entryPrice,
  stopPrice: finalStop,
  tick,
});
if (!stopNorm.ok) {
  return { __poison: true, message: `stop_normalization_failed: ${stopNorm.reason}` } as any;
}
finalStop = stopNorm.stop;

finalTp = normalizeLimitPrice({ price: finalTp, tick });

const minTpLong = Number((entryPrice + tick).toFixed(2));
const maxTpShort = Number((entryPrice - tick).toFixed(2));

const wantTp =
  sideDirection === "buy"
    ? finalTp >= minTpLong
    : finalTp <= maxTpShort;

const payload: any = {
  symbol: ticker,
  qty,
  side: sideDirection,
  type: "market",
  time_in_force: "day",
  order_class: wantTp ? "bracket" : "oto",
  stop_loss: { stop_price: finalStop },  // ← Quantized
};

if (wantTp) payload.take_profit = { limit_price: finalTp };  // ← Quantized

try {
  return await createOrder(payload);
} catch (e: any) {
  // ... error handling ...
}
```

---

## 6. lib/alpaca.ts (~line 80)
```typescript
// In enforceBracketBasePriceConstraint():

const tick = tickForEquityPrice(base);
const min = tick;

if (side === "buy") {
  if (Number.isFinite(tp) && tp < base + min) {
    const normalized = normalizeLimitPrice({ price: base + min, tick });
    order.take_profit = { ...(order.take_profit || {}), limit_price: normalized };
  }
  if (Number.isFinite(sl) && sl > base - min) {
    const normResult = normalizeStopPrice({
      side: "LONG",
      entryPrice: base,
      stopPrice: base - min,
      tick,
    });
    if (normResult.ok) {
      order.stop_loss = { ...(order.stop_loss || {}), stop_price: normResult.stop };
    }
  }
} else if (side === "sell") {
  if (Number.isFinite(tp) && tp > base - min) {
    const normalized = normalizeLimitPrice({ price: base - min, tick });
    order.take_profit = { ...(order.take_profit || {}), limit_price: normalized };
  }
  if (Number.isFinite(sl) && sl < base + min) {
    const normResult = normalizeStopPrice({
      side: "SHORT",
      entryPrice: base,
      stopPrice: base + min,
      tick,
    });
    if (normResult.ok) {
      order.stop_loss = { ...(order.stop_loss || {}), stop_price: normResult.stop };
    }
  }
}
```

---

## Validation Examples

### Example 1: Sub-penny stop on apply-stop endpoint
```
Input:  { tradeId: "xyz", stopPrice: 24.0591 }
        (entry: 24.05, side: LONG)
        
Process: normalizeStopPrice({
  side: "LONG",
  entryPrice: 24.05,
  stopPrice: 24.0591,
  tick: 0.01
})

Output: { ok: true, stop: 24.05 }  (floors to below entry ✓)

Result: Order submitted with stop_price: 24.05 ✓
```

### Example 2: Invalid directional stop
```
Input:  { tradeId: "xyz", stopPrice: 24.06 }
        (entry: 24.05, side: LONG)
        
Process: normalizeStopPrice({
  side: "LONG",
  entryPrice: 24.05,
  stopPrice: 24.06,  // ← Above entry!
  tick: 0.01
})

Output: { ok: false, reason: "stop_not_below_entry_for_long", stop: 24.06 }

Result: HTTP 400 response with reason and values ✓
```

### Example 3: Floating-point artifact in auto-suggestion
```
Risk:     oneRVal = $0.05 (1R risk)
Shares:   100
Entry:    24.05

Raw:      24.05 + 0.05/100 = 24.0505  (sub-penny!)

Process: normalizeStopPrice({
  side: "SHORT",
  entryPrice: 24.05,
  stopPrice: 24.0505,
  tick: 0.01
})

Output: { ok: true, stop: 24.06 }  (ceils to above entry for SHORT ✓)

Result: Trade stored with suggestedStopPrice: 24.06 ✓
```

---

## Error Responses

### apply-stop normalization failure:
```json
{
  "ok": false,
  "error": "stop_price_normalization_failed",
  "reason": "stop_not_below_entry_for_long",
  "original": 24.06,
  "normalized": 24.06
}
```

### stopSync normalization failure:
```
{
  "ok": false,
  "error": "stop_normalization_failed",
  "detail": "reason=stop_not_above_entry_for_short original=24.04 normalized=24.04"
}
```

### auto-entry bracket failure (poison):
```
{ __poison: true, message: "stop_normalization_failed: stop_not_below_entry_for_long" }
```
(Triggers auto-disable guardrail)
