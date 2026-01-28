# Code Changes: Before & After

## 1. GET Handler for Query Params (app/api/auto-manage/run/route.ts)

**BEFORE**: Only POST endpoint

**AFTER**: Added GET handler
```typescript
export async function GET(req: Request) {
  const now = new Date().toISOString();
  try {
    const { searchParams } = new URL(req.url);
    const source = req.headers.get("x-run-source") || "unknown";
    const runId = req.headers.get("x-run-id") || "";

    // Support force=1, ignoreMarket=1, or force=true query params
    const force =
      searchParams.get("force") === "1" ||
      searchParams.get("force") === "true" ||
      searchParams.get("ignoreMarket") === "1";

    const result = await runAutoManage({ source, runId, force });
    return NextResponse.json(result, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, now, error: err?.message || "auto_manage_failed" },
      { status: 500 }
    );
  }
}
```

**Usage**:
```bash
curl "http://localhost:3000/api/auto-manage/run?force=1"
curl "http://localhost:3000/api/auto-manage/run?ignoreMarket=1"
curl "http://localhost:3000/api/auto-manage/run?force=true"
```

---

## 2. Audit Flag in Response (lib/autoManage/engine.ts)

**BEFORE** (Type):
```typescript
export type AutoManageResult = {
  ok: true;
  skipped?: boolean;
  reason?: string;
  checked: number;
  updated: number;
  flattened: number;
  enabled: boolean;
  now: string;
  market?: any;
  notes?: string[];
  cfg: ReturnType<typeof getAutoManageConfig>;
};
```

**AFTER** (Type):
```typescript
export type AutoManageResult = {
  ok: true;
  skipped?: boolean;
  reason?: string;
  checked: number;
  updated: number;
  flattened: number;
  enabled: boolean;
  now: string;
  market?: any;
  notes?: string[];
  forced?: boolean;  // ← NEW: Audit trail for forced runs
  cfg: ReturnType<typeof getAutoManageConfig>;
};
```

**BEFORE** (Return):
```typescript
return { ok: true, checked, updated, flattened, enabled: true, now, market: clock, notes: notesCapped, cfg };
```

**AFTER** (Return):
```typescript
return { ok: true, checked, updated, flattened, enabled: true, now, market: clock, notes: notesCapped, forced: force ? true : undefined, cfg };
```

**Example Response**:
```json
{
  "ok": true,
  "checked": 3,
  "updated": 2,
  "forced": true,  // ← When force=1 was used
  "notes": [
    "quantize:AAPL:price_adjusted_for_tick_compliance: 24.0591 -> 24.06 (diff: 0.000877)"
  ]
}
```

---

## 3. Quantization Note Tracking (lib/autoManage/stopSync.ts)

**BEFORE** (Type):
```typescript
export type StopSyncResult =
  | { ok: true; qty: number; stopOrderId: string; cancelled: string[] }
  | { ok: false; error: string; detail?: string };
```

**AFTER** (Type):
```typescript
export type StopSyncResult =
  | { ok: true; qty: number; stopOrderId: string; cancelled: string[]; quantizationNote?: string }
  | { ok: false; error: string; detail?: string; quantizationNote?: string };
```

**BEFORE** (Quantization):
```typescript
const stopOrder = await createOrder({
  symbol: ticker,
  qty,
  side: stopSide,
  type: "stop",
  time_in_force: "day",
  stop_price: normResult.stop,
  extended_hours: false,
});

return { ok: true, qty, stopOrderId: String((stopOrder as any)?.id || ""), cancelled };
```

**AFTER** (Quantization with Tracking):
```typescript
// Check if quantization changed the price significantly
const quantizationDiff = Math.abs(normResult.stop - nextStopPrice);
let quantizationNote: string | undefined;
if (quantizationDiff > 0.0001) {
  quantizationNote = `price_adjusted_for_tick_compliance: ${nextStopPrice} -> ${normResult.stop} (diff: ${quantizationDiff.toFixed(6)})`;
}

const stopOrder = await createOrder({
  symbol: ticker,
  qty,
  side: stopSide,
  type: "stop",
  time_in_force: "day",
  stop_price: normResult.stop,
  extended_hours: false,
});

return { 
  ok: true, 
  qty, 
  stopOrderId: String((stopOrder as any)?.id || ""), 
  cancelled,
  quantizationNote,  // ← NEW: Debug info about price adjustment
};
```

**Example Note**:
```
price_adjusted_for_tick_compliance: 24.059123 -> 24.06 (diff: 0.000877)
```

---

## 4. Quantization Logging in Engine (lib/autoManage/engine.ts)

**BEFORE** (Success path):
```typescript
if (changedStop) {
  const res = await syncStopForTrade(next[idx], nextStop);
  if (res.ok) {
    next[idx] = {
      ...next[idx],
      quantity: res.qty,
      stopPrice: nextStop,
      stopOrderId: res.stopOrderId,
      autoManage: {
        ...(next[idx].autoManage || {}),
        lastStopSyncAt: now,
        lastStopSyncStatus: "OK",
        lastStopSyncCancelled: res.cancelled,
      },
      updatedAt: now,
      error: undefined,
    };
    // [No quantization logging]
  } else {
    // ... error handling ...
  }
}
```

**AFTER** (Success path with quantization logging):
```typescript
if (changedStop) {
  const res = await syncStopForTrade(next[idx], nextStop);
  if (res.ok) {
    next[idx] = {
      ...next[idx],
      quantity: res.qty,
      stopPrice: nextStop,
      stopOrderId: res.stopOrderId,
      autoManage: {
        ...(next[idx].autoManage || {}),
        lastStopSyncAt: now,
        lastStopSyncStatus: "OK",
        lastStopSyncCancelled: res.cancelled,
      },
      updatedAt: now,
      error: undefined,
    };
    if (res.quantizationNote) {
      notes.push(`quantize:${ticker}:${res.quantizationNote}`);
    }
  } else {
    stopSyncOk = false;
    stopSyncNote = `${res.error}${res.detail ? ":" + res.detail : ""}`;
    if (res.quantizationNote) {
      stopSyncNote += ` [${res.quantizationNote}]`;
    }
    next[idx] = {
      ...next[idx],
      autoManage: {
        ...(next[idx].autoManage || {}),
        lastStopSyncAt: now,
        lastStopSyncStatus: "FAIL",
        lastStopSyncError: stopSyncNote,
      },
      updatedAt: now,
    };
  }
}
```

**Example Logging Output**:
```
notes.push("quantize:AAPL:price_adjusted_for_tick_compliance: 24.0591 -> 24.06 (diff: 0.000900)")
// Becomes in response:
"notes": [
  "quantize:AAPL:price_adjusted_for_tick_compliance: 24.0591 -> 24.06 (diff: 0.000900)",
  "t:AAPL r:1.234 px:24.25 stop:24.05→24.06 rule:BE_1R sync:OK",
  ...
]
```

---

## 5. Complete Flow Example

### Request
```bash
curl "http://localhost:3000/api/auto-manage/run?force=1"
```

### Processing
1. GET handler receives `force=1`
2. Calls `runAutoManage({ force: true })`
3. Market is closed, but `force=true` bypasses skip
4. Processes OPEN trades
5. For each stop adjustment:
   - Calls `syncStopForTrade()` with raw `nextStop`
   - stopSync.ts quantizes: `24.0591 -> 24.06`
   - Detects diff > 0.0001: includes quantizationNote
   - Returns `{ ok: true, ..., quantizationNote: "..." }`
6. Engine adds note to response
7. Returns with `forced: true` flag

### Response
```json
{
  "ok": true,
  "checked": 3,
  "updated": 2,
  "flattened": 0,
  "enabled": true,
  "now": "2026-01-28T22:15:30.123Z",
  "forced": true,
  "market": {
    "is_open": false,
    "next_open": "2026-01-29T09:30:00Z"
  },
  "notes": [
    "quantize:AAPL:price_adjusted_for_tick_compliance: 24.0591 -> 24.06 (diff: 0.000900)",
    "t:AAPL r:1.567 px:24.25 stop:24.05→24.06 rule:BE_1R sync:OK",
    "t:MSFT r:2.123 px:420.15 stop:419.90→419.95 rule:LOCK_2R sync:OK"
  ],
  "cfg": { ... }
}
```

---

## Key Differences Summary

| Aspect | Before | After |
|--------|--------|-------|
| **Query params** | ❌ Not supported | ✅ GET with ?force=1, ?ignoreMarket=1 |
| **Audit trail** | ❌ No indication of force | ✅ "forced": true in response |
| **Price adjustments** | ⚠️ Silent (no logging) | ✅ "quantizationNote" with diff details |
| **Response tracking** | Basic OK/updated counts | ✅ Plus forced flag + quantization notes |
| **Type safety** | Basic StopSyncResult | ✅ Extended with quantizationNote |
| **Sub-penny handling** | Uses normalized stop | ✅ Plus explicit logging of adjustments |

---

## Validation

### Before Applying Changes
- Market closed: `/api/auto-manage/run` returns `{skipped: true, reason: "market_closed"}`
- No quantization tracking

### After Applying Changes
- Market closed, no force: `{skipped: true, reason: "market_closed"}` ✅
- Market closed with force=1: Processes trades, returns `{forced: true, notes: [...]}` ✅
- All stops quantized before Alpaca submission ✅
- Debug notes in response when price adjusted > 0.0001 ✅
- Backward compatible: existing calls unchanged ✅
