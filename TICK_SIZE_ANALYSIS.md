# Alpaca Stop Price Sub-Penny Increment Issue (Error 42210000)

## Executive Summary

Alpaca rejects stop prices with sub-penny increments (e.g., 24.0591) via error 42210000. **The root cause is precision loss from floating-point arithmetic**, compounded by inconsistent rounding strategies across multiple code paths. This analysis identifies all code paths and proposes a unified tick-size compliance function.

---

## Problem Statement

**Error 42210000** occurs when `stop_price` values violate Alpaca's tick-size requirements:
- **US Equities**: Tick size = $0.01 (penny increments)
- **Invalid examples**: 24.0591, 24.059102, 24.01234
- **Valid examples**: 24.05, 24.06, 24.10

**Root Cause**: Floating-point arithmetic introduces sub-penny precision:
```typescript
// Example: entryPrice = 24.05, stopDistance = 0.0001
const stop = 24.05 - 0.0001;  // JavaScript: 24.049999999999... (binary representation)
// Even with `.toFixed(2)`, conversion back to Number may lose the rounding
Number((24.049999999999).toFixed(2))  // = 24.05 ✓ (works by luck)
// But:
const x = 24.05 - 0.00010000000001;
Number(x.toFixed(2))  // = 24.05 (truncates 24.04999...)
```

---

## Code Paths That Compute/Send stop_price

### 1. **[lib/autoEntry/pricing.ts](lib/autoEntry/pricing.ts)** - Primary Bracket Computation
**Function**: `computeBracket()`
- **Line**: Computes initial stop price via arithmetic
```typescript
let stopPrice = side === "LONG"
  ? round2(entryPrice - normalizedStopDistance)  // round2 = Math.round(n*100)/100
  : round2(entryPrice + normalizedStopDistance);
```
- **Issues**:
  - `round2()` uses banker's rounding (Math.round), which can fail for edge cases
  - No explicit tick-size validation post-rounding
  - `minTick()` function exists but applies `Math.round()` again (double rounding)

**Additional function**: `clampBracketPrices()` also calls `minTick()` on stop prices:
```typescript
let st = minTick(opts.stopPrice, tick);  // Re-rounds already-rounded value
```

---

### 2. **[app/api/auto-entry/execute/route.ts](app/api/auto-entry/execute/route.ts)** - Order Submission
**Function**: `validateAndRepairBracket()` - Lines 150-200+
```typescript
const roundUp = (x: number) => Number((Math.ceil(x / tick) * tick).toFixed(2));
const roundDown = (x: number) => Number((Math.floor(x / tick) * tick).toFixed(2));
```
- **Issues**:
  - Redefines rounding functions locally (duplicated logic)
  - `Math.ceil(x / 0.01)` can overflow precision for values near tick boundaries
  - `.toFixed(2).then(Number())` can still lose precision if intermediate float is sub-penny

**Order creation**: Lines 765+
```typescript
stop_loss: { stop_price: finalStop }  // finalStop should be pre-validated
```

---

### 3. **[app/api/trades/apply-stop/route.ts](app/api/trades/apply-stop/route.ts)** - Manual Stop Application
**Function**: `POST /api/trades/apply-stop`
- **Lines**: 114
```typescript
const stopOrder = await createOrder({
  symbol: ticker,
  qty,
  side: stopSide,
  type: "stop",
  time_in_force: "day",
  stop_price: stopPrice,  // Direct pass-through, NO validation
  extended_hours: false,
});
```
- **Issues**:
  - **No tick-size validation before submission**
  - User can submit sub-penny values directly

---

### 4. **[lib/autoManage/stopSync.ts](lib/autoManage/stopSync.ts)** - Stop Tightening
**Function**: `syncStopForTrade()` - Lines 50+
```typescript
const stopOrder = await createOrder({
  symbol: ticker,
  qty,
  side: stopSide,
  type: "stop",
  time_in_force: "day",
  stop_price: nextStopPrice,  // Direct pass-through, NO validation
  extended_hours: false,
});
```
- **Issues**:
  - **No tick-size validation before submission**
  - User-supplied `nextStopPrice` not validated

---

### 5. **[app/api/trades/manage/route.ts](app/api/trades/manage/route.ts)** - Stop Suggestions & Auto-Apply
**Function**: `autoApplyStop()` - Lines 108-130
```typescript
const newStop = trade.suggestedStopPrice;
await replaceOrder(stopLeg.id, { stop_price: newStop });  // NO validation
```
- **Issues**:
  - Computed suggested stops in lines 245-258 use arithmetic without post-rounding:
  ```typescript
  const lockIn = t.side.toUpperCase() === "LONG"
    ? entry + oneRVal / t.size  // Can produce sub-penny values
    : entry - oneRVal / t.size;
  suggestedStopPrice = lockIn;
  ```
  - No call to tick-size rounding before storage/submission

---

### 6. **[lib/alpaca.ts](lib/alpaca.ts)** - Bracket Constraint Enforcement
**Function**: `enforceBracketBasePriceConstraint()` - Lines 78-108
```typescript
order.stop_loss = { ...(order.stop_loss || {}), 
  stop_price: Number((base - min).toFixed(2)) };
```
- **Issues**:
  - Uses `toFixed(2)` + `Number()`, which can fail for accumulated floats
  - Only triggered for bracket orders, not standalone stops
  - Defensive measure, but insufficient as primary safeguard

---

## Tick-Size Compliance Rules

For US equities:
- **Prices ≥ $1.00**: Tick size = $0.01
- **Prices < $1.00**: Tick size = $0.0001 (penny stocks)
- **For day trading scope**: Assume $0.01 for equities ≥ $1.00

## Proposed Fix: Unified Tick-Size Quantizer

Create a single, authoritative function in a new utility module:

### [lib/tickSize.ts](lib/tickSize.ts) (NEW)
```typescript
/**
 * Quantize a price to the nearest tick for US equity compliance.
 * 
 * For US equities:
 * - Prices >= $1.00: tick = $0.01 (penny)
 * - Prices < $1.00: tick = $0.0001 (sub-penny for penny stocks)
 * 
 * @param price - Raw price value
 * @param tickSize - Tick size in dollars (default 0.01 for regular equities)
 * @param roundMode - 'nearest' (default), 'up', 'down'
 * @returns Tick-compliant price (exactly 2 decimal places)
 */
export function quantizePrice(
  price: number,
  tickSize: number = 0.01,
  roundMode: "nearest" | "up" | "down" = "nearest"
): number {
  // Validate input
  if (!Number.isFinite(price)) {
    throw new Error(`Invalid price: ${price}`);
  }
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error(`Invalid tickSize: ${tickSize}`);
  }

  let quantized: number;
  
  // Use integer arithmetic to avoid floating-point errors
  // Scale to cents (for $0.01 tick) or mils (for $0.0001 tick)
  const decimalPlaces = Math.round(-Math.log10(tickSize));
  const scaleFactor = Math.pow(10, decimalPlaces);
  
  const scaled = Math.round(price * scaleFactor); // Scale to integer units
  
  const tickScaled = Math.round(tickSize * scaleFactor); // Tick in integer units
  
  switch (roundMode) {
    case "up":
      quantized = Math.ceil(scaled / tickScaled) * tickScaled;
      break;
    case "down":
      quantized = Math.floor(scaled / tickScaled) * tickScaled;
      break;
    case "nearest":
    default:
      quantized = Math.round(scaled / tickScaled) * tickScaled;
      break;
  }

  // Scale back to dollars, then round to safe decimal places
  const result = quantized / scaleFactor;
  
  // Force exactly the expected decimal places to prevent floating-point artifacts
  return Number(result.toFixed(decimalPlaces));
}

/**
 * Ensure stop price is compliant with tick size and directionally valid.
 * 
 * @param params - { side, basePrice, stopPrice, tickSize }
 * @returns { valid: boolean, stopPrice: number (if valid), reason?: string }
 */
export function validateStopPrice(params: {
  side: "LONG" | "SHORT";
  basePrice: number;
  stopPrice: number;
  tickSize?: number;
}): { valid: boolean; stopPrice: number; reason?: string } {
  const { side, basePrice, stopPrice, tickSize = 0.01 } = params;

  // Validate inputs
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    return { valid: false, stopPrice, reason: "invalid_basePrice" };
  }
  if (!Number.isFinite(stopPrice)) {
    return { valid: false, stopPrice, reason: "invalid_stopPrice" };
  }

  // Quantize stop price
  let quantized: number;
  try {
    quantized = quantizePrice(stopPrice, tickSize, "nearest");
  } catch (e) {
    return { valid: false, stopPrice, reason: `quantization_error: ${e}` };
  }

  // Validate directional constraint
  const minDistance = tickSize;
  if (side === "LONG") {
    // For long, stop must be below entry
    if (quantized >= basePrice) {
      return {
        valid: false,
        stopPrice: quantized,
        reason: "stop_must_be_below_entry_for_long",
      };
    }
  } else {
    // For short, stop must be above entry
    if (quantized <= basePrice) {
      return {
        valid: false,
        stopPrice: quantized,
        reason: "stop_must_be_above_entry_for_short",
      };
    }
  }

  return { valid: true, stopPrice: quantized };
}

/**
 * Validate bracket prices (entry, stop, TP) for Alpaca compliance.
 */
export function validateBracketPrices(params: {
  side: "LONG" | "SHORT";
  basePrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  tickSize?: number;
}): {
  valid: boolean;
  basePrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  reason?: string;
} {
  const { side, basePrice, stopPrice, takeProfitPrice, tickSize = 0.01 } = params;

  // Validate base price
  const baseQuantized = quantizePrice(basePrice, tickSize, "nearest");

  // Validate stop price
  const stopValid = validateStopPrice({
    side,
    basePrice: baseQuantized,
    stopPrice,
    tickSize,
  });
  if (!stopValid.valid) {
    return { valid: false, ...params, reason: stopValid.reason };
  }

  // Validate TP directional constraint
  let tpQuantized: number;
  try {
    tpQuantized = quantizePrice(takeProfitPrice, tickSize, "nearest");
  } catch {
    return {
      valid: false,
      basePrice: baseQuantized,
      stopPrice: stopValid.stopPrice,
      takeProfitPrice,
      reason: "invalid_takeProfitPrice",
    };
  }

  const minDistance = tickSize;
  if (side === "LONG") {
    // For long: TP must be > entry
    if (tpQuantized <= baseQuantized) {
      return {
        valid: false,
        basePrice: baseQuantized,
        stopPrice: stopValid.stopPrice,
        takeProfitPrice: tpQuantized,
        reason: "tp_must_be_above_entry_for_long",
      };
    }
  } else {
    // For short: TP must be < entry
    if (tpQuantized >= baseQuantized) {
      return {
        valid: false,
        basePrice: baseQuantized,
        stopPrice: stopValid.stopPrice,
        takeProfitPrice: tpQuantized,
        reason: "tp_must_be_below_entry_for_short",
      };
    }
  }

  return {
    valid: true,
    basePrice: baseQuantized,
    stopPrice: stopValid.stopPrice,
    takeProfitPrice: tpQuantized,
  };
}
```

---

## Implementation Plan

### Phase 1: Add Utility (Low Risk)
1. Create [lib/tickSize.ts](lib/tickSize.ts) with functions above
2. Add unit tests for edge cases (e.g., 24.049999..., 24.050001...)
3. **No breaking changes yet**

### Phase 2: Refactor Pricing Module (Medium Risk)
4. Update [lib/autoEntry/pricing.ts](lib/autoEntry/pricing.ts):
   ```typescript
   import { quantizePrice, validateBracketPrices } from "@/lib/tickSize";
   
   export function computeBracket({ ... }) {
     // ... existing computation ...
     
     // Replace final rounding with validation
     const validated = validateBracketPrices({
       side,
       basePrice: entryPrice,
       stopPrice,
       takeProfitPrice,
     });
     
     if (!validated.valid) {
       throw new Error(`Invalid bracket prices: ${validated.reason}`);
     }
     
     return {
       entryPrice: validated.basePrice,
       stopPrice: validated.stopPrice,
       takeProfitPrice: validated.takeProfitPrice,
     };
   }
   ```

### Phase 3: Secure Order Submission (High Priority)
5. Update [app/api/trades/apply-stop/route.ts](app/api/trades/apply-stop/route.ts):
   ```typescript
   import { validateStopPrice } from "@/lib/tickSize";
   
   // Before createOrder:
   const stopValidation = validateStopPrice({
     side: trade.side === "LONG" ? "LONG" : "SHORT",
     basePrice: trade.entryPrice || 0,
     stopPrice,
   });
   
   if (!stopValidation.valid) {
     return NextResponse.json(
       { ok: false, error: stopValidation.reason },
       { status: 400 }
     );
   }
   
   const stopOrder = await createOrder({
     symbol: ticker,
     qty,
     side: stopSide,
     type: "stop",
     time_in_force: "day",
     stop_price: stopValidation.stopPrice,  // Use quantized value
     extended_hours: false,
   });
   ```

6. Update [lib/autoManage/stopSync.ts](lib/autoManage/stopSync.ts):
   ```typescript
   import { validateStopPrice } from "@/lib/tickSize";
   
   const stopValidation = validateStopPrice({
     side,
     basePrice: 0,  // We don't have entry, use 0 for directional check
     stopPrice: nextStopPrice,
   });
   
   if (!stopValidation.valid) {
     return { ok: false, error: stopValidation.reason };
   }
   
   const stopOrder = await createOrder({
     symbol: ticker,
     qty,
     side: stopSide,
     type: "stop",
     time_in_force: "day",
     stop_price: stopValidation.stopPrice,
     extended_hours: false,
   });
   ```

### Phase 4: Refactor Auto-Manage Suggestions (Medium Priority)
7. Update [app/api/trades/manage/route.ts](app/api/trades/manage/route.ts):
   ```typescript
   import { quantizePrice } from "@/lib/tickSize";
   
   // Lines ~250:
   const lockIn = t.side.toUpperCase() === "LONG"
     ? quantizePrice(entry + oneRVal / t.size)
     : quantizePrice(entry - oneRVal / t.size);
   suggestedStopPrice = lockIn;
   ```

### Phase 5: Simplify Auto-Entry (Low Risk)
8. Update [app/api/auto-entry/execute/route.ts](app/api/auto-entry/execute/route.ts):
   - Remove duplicate `roundUp`/`roundDown` functions
   - Replace with single `validateBracketPrices()` call before order submission

---

## Safest Implementation Strategy

**Conservative Approach** (Recommended for production):

1. **Deploy [lib/tickSize.ts](lib/tickSize.ts)** with full test coverage
2. **Immediately secure [app/api/trades/apply-stop/route.ts](app/api/trades/apply-stop/route.ts)** (user input validation)
3. **Next: [lib/autoManage/stopSync.ts](lib/autoManage/stopSync.ts)** (user-triggered updates)
4. **Then: [app/api/trades/manage/route.ts](app/api/trades/manage/route.ts)** (auto-suggestions)
5. **Finally: Refactor [lib/autoEntry/pricing.ts](lib/autoEntry/pricing.ts)** (core computation, most tested)

This sequence reduces risk by securing all user input paths first, then gradually refactoring core logic.

---

## Test Cases

```typescript
// Edge case: sub-penny float arithmetic
quantizePrice(24.049999999999) === 24.05  ✓
quantizePrice(24.050001) === 24.05  ✓
quantizePrice(24.055) === 24.06  ✓
quantizePrice(24.054) === 24.05  ✓

// Rounding modes
quantizePrice(24.054, 0.01, "down") === 24.05  ✓
quantizePrice(24.054, 0.01, "up") === 24.06  ✓

// Direction validation
validateStopPrice({ side: "LONG", basePrice: 24.05, stopPrice: 24.04 })
  ✓ { valid: true, stopPrice: 24.04 }
  
validateStopPrice({ side: "LONG", basePrice: 24.05, stopPrice: 24.06 })
  ✗ { valid: false, reason: "stop_must_be_below_entry_for_long" }
```

---

## Summary

| Path | Current Risk | Proposed Fix | Priority |
|------|-------------|--------------|----------|
| apply-stop/route.ts | **HIGH** - No validation | Add validateStopPrice() | **1** |
| stopSync.ts | **HIGH** - No validation | Add validateStopPrice() | **2** |
| manage/route.ts | **MEDIUM** - Arithmetic without rounding | Use quantizePrice() | **3** |
| auto-entry/execute/route.ts | **MEDIUM** - Duplicate logic, inconsistent | Consolidate to validateBracketPrices() | **4** |
| autoEntry/pricing.ts | **MEDIUM** - Double rounding | Use validateBracketPrices() | **5** |
| alpaca.ts | **LOW** - Defensive only | Improve with quantizePrice() | **6** |

**Estimated implementation time**: 4-6 hours (including testing)  
**Breaking changes**: None (all additions and post-hoc validation)
