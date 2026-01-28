# Auto-Manage Force Flag + Stop Price Quantization Implementation

**Date**: January 28, 2026  
**Issue**: Allow force execution when market is closed + ensure all stop prices use tick quantization  
**Status**: ✅ IMPLEMENTED

---

## Files Modified (3)

### 1. **app/api/auto-manage/run/route.ts**
Added GET endpoint with query parameter support alongside existing POST

**Changes**:
```typescript
// Added GET handler with query param support
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

**Impact**: 
- Users can now call `/api/auto-manage/run?force=1` to run stop-sync even when market is closed
- Supports both POST (body: `{force: true}`) and GET (query: `?force=1` or `?ignoreMarket=1`)
- Market status still checked (as `is_open`), but `force` bypasses the gating

---

### 2. **lib/autoManage/engine.ts**
Updated return type and response to include audit flag

**Changes**:

A. **Type definition** (line 8):
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
  forced?: boolean;  // ← NEW FIELD FOR AUDIT
  cfg: ReturnType<typeof getAutoManageConfig>;
};
```

B. **Return statement** (line 245):
```typescript
const notesCapped = notes.slice(0, 50);
return { 
  ok: true, 
  checked, 
  updated, 
  flattened, 
  enabled: true, 
  now, 
  market: clock, 
  notes: notesCapped, 
  forced: force ? true : undefined,  // ← INCLUDE FORCED FLAG IF USED
  cfg 
};
```

C. **Enhanced logging** in stop-sync section (lines 160-195):
```typescript
if (changedStop) {
  const res = await syncStopForTrade(next[idx], nextStop);
  if (res.ok) {
    // ... existing code ...
    if (res.quantizationNote) {
      notes.push(`quantize:${ticker}:${res.quantizationNote}`);
    }
  } else {
    // ... existing code ...
    if (res.quantizationNote) {
      stopSyncNote += ` [${res.quantizationNote}]`;
    }
  }
}
```

**Impact**:
- Response now includes `"forced": true` when `force=1` is used (audit trail)
- Quantization notes logged when price is adjusted for tick compliance
- Debug notes capture the adjustment amount (e.g., "price adjusted 24.0591 -> 24.05")

---

### 3. **lib/autoManage/stopSync.ts**
Enhanced quantization tracking and debugging

**Changes**:

A. **Type definition** (line 22):
```typescript
export type StopSyncResult =
  | { ok: true; qty: number; stopOrderId: string; cancelled: string[]; quantizationNote?: string }
  | { ok: false; error: string; detail?: string; quantizationNote?: string };
```

B. **Quantization check and logging** (lines 122-143):
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
  stop_price: normResult.stop,  // ← USE QUANTIZED VALUE
  extended_hours: false,
});

return { 
  ok: true, 
  qty, 
  stopOrderId: String((stopOrder as any)?.id || ""), 
  cancelled,
  quantizationNote,  // ← RETURN NOTE FOR DEBUGGING
};
```

**Impact**:
- All stop prices now quantized before Alpaca submission (via `normalizeStopPrice()`)
- LONG stops floor to nearest tick (conservative, below entry)
- SHORT stops ceil to nearest tick (conservative, above entry)
- Debug note included when adjustment > 0.0001
- Example: `price_adjusted_for_tick_compliance: 24.0591 -> 24.06 (diff: 0.000900)`

---

## Behavior Flow

### Scenario 1: Force Run When Market Closed

```
GET /api/auto-manage/run?force=1

→ engine.runAutoManage({ force: true })
  → marketClosed = true, eodFlatten = false
  → Skip check bypassed: !force === false
  → Proceeds to process OPEN trades
  → Calls syncStopForTrade() for each trade needing adjustment
  
→ Response includes:
{
  ok: true,
  checked: 5,
  updated: 2,
  flattened: 0,
  forced: true,           // ← AUDIT FLAG
  notes: [
    "quantize:AAPL:price_adjusted_for_tick_compliance: 24.0591 -> 24.06 (diff: 0.000900)",
    "t:AAPL r:1.234 px:24.25 stop:24.05→24.06 rule:BE_1R sync:OK",
    ...
  ]
}
```

### Scenario 2: Normal Run When Market Closed (No Force)

```
GET /api/auto-manage/run

→ engine.runAutoManage({ force: false })
  → marketClosed = true, eodFlatten = false
  → Skip check: marketClosed && !eodFlatten && !force === true
  → Returns early (skipped)
  
→ Response:
{
  ok: true,
  skipped: true,
  reason: "market_closed",
  checked: 0,
  updated: 0,
  forced: undefined
}
```

### Scenario 3: Normal Run During Market Hours

```
POST /api/auto-manage/run { force: true }

→ engine.runAutoManage({ force: true })
  → marketClosed = false
  → Skip check bypassed (market is open anyway)
  → Processes OPEN trades normally
  → All stops quantized via normalizeStopPrice()
  
→ Response:
{
  ok: true,
  checked: 5,
  updated: 2,
  forced: true,
  notes: [
    "t:AAPL r:2.456 px:24.25 stop:24.02→24.04 rule:LOCK_2R sync:OK",
    ...
  ]
}
```

---

## Safety Guardrails Maintained

✅ **cfg.enabled check**: Still required (returns `skipped: disabled` if false)  
✅ **Kill switch**: No bypass added to pause/disable mechanisms  
✅ **Market status logging**: Still included in response (visible in notes)  
✅ **Quantity validation**: Unchanged (no stop created without qty)  
✅ **Tightening check**: Unchanged (only tightens stops, never loosens)  
✅ **Tick quantization**: NEW - All stops quantized to valid increments

---

## Query Parameter Reference

### GET /api/auto-manage/run

| Parameter | Values | Effect |
|-----------|--------|--------|
| `force` | `1`, `true` | Bypass market closed gating |
| `ignoreMarket` | `1` | Alias for `force=1` |

**Examples**:
```bash
# Force run when market is closed
curl "http://localhost:3000/api/auto-manage/run?force=1"
curl "http://localhost:3000/api/auto-manage/run?ignoreMarket=1"
curl "http://localhost:3000/api/auto-manage/run?force=true"

# Normal run (respects market status)
curl "http://localhost:3000/api/auto-manage/run"
```

### POST /api/auto-manage/run

```bash
# Force run via body
curl -X POST http://localhost:3000/api/auto-manage/run \
  -H "Content-Type: application/json" \
  -d '{"force": true}'

# Normal run
curl -X POST http://localhost:3000/api/auto-manage/run \
  -d '{}'
```

---

## Stop Price Quantization Details

### LONG Trades
- **Input**: 24.0591 (sub-penny from floating-point)
- **Quantizer**: `normalizeStopPrice()` with `floor` mode
- **Output**: 24.05 (rounded down to nearest tick, below entry)
- **Reason**: Conservative - doesn't trigger prematurely

### SHORT Trades
- **Input**: 24.0491 (sub-penny)
- **Quantizer**: `normalizeStopPrice()` with `ceil` mode
- **Output**: 24.05 (rounded up to nearest tick, above entry)
- **Reason**: Conservative - doesn't trigger prematurely

### Debug Note Triggered
- **When**: `|quantized - input| > 0.0001`
- **Example**: `price_adjusted_for_tick_compliance: 24.0591 -> 24.06 (diff: 0.000900)`
- **Logged in**: `notes[]` array and engine.lastStopSyncError if sync fails

---

## Testing Checklist

- [ ] Run `/api/auto-manage/run?force=1` when market is closed → should process trades
- [ ] Run `/api/auto-manage/run` when market is closed → should skip with `reason: "market_closed"`
- [ ] Check response includes `forced: true` when force param is used
- [ ] Verify quantization notes appear in response `notes[]` when adjustment > 0.0001
- [ ] Confirm stop prices submitted to Alpaca are tick-aligned (no 42210000 error)
- [ ] Verify LONG stops are always <= entry, SHORT stops always >= entry
- [ ] Check database trades store the correct quantized `stopPrice`

---

## Example Response with Force + Quantization

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
    "timestamp": "2026-01-28T22:15:30.123456Z",
    "is_open": false,
    "next_open": "2026-01-29T09:30:00Z"
  },
  "notes": [
    "quantize:AAPL:price_adjusted_for_tick_compliance: 24.059123 -> 24.06 (diff: 0.000877)",
    "t:AAPL r:1.567 px:24.25 stop:24.05→24.06 rule:BE_1R sync:OK",
    "t:MSFT r:2.123 px:420.15 stop:419.90→419.95 rule:LOCK_2R sync:OK",
    "t:GOOGL r:0.456 px:180.50 stop:180.45→180.45 rule:NONE sync:OK"
  ],
  "cfg": {
    "enabled": true,
    "eodFlatten": false,
    "trailEnabled": true,
    "trailStartR": 1.5,
    "trailPct": 0.01,
    "maxPerRun": 10
  }
}
```

---

## Key Implementation Details

### Force Flag Logic (engine.ts line 87)
```typescript
if (marketClosed && !cfg.eodFlatten && !force) {
  // Skip only if ALL three conditions are true:
  // - Market is closed AND
  // - EOD flatten is disabled AND
  // - Force is NOT requested
  
  // If ANY is false, proceeds to process trades
}
```

### Quantization Logic (stopSync.ts lines 118-145)
```typescript
1. normalizeStopPrice() quantizes value + validates direction
2. Check diff = |quantized - input|
3. If diff > 0.0001, generate debug note
4. Submit quantized value to Alpaca (never sub-penny)
5. Return note for audit logging
```

### Audit Trail
- **Response field**: `forced: true` when force=1
- **Notes array**: Quantization adjustments logged
- **Database**: Trade record stores final quantized stopPrice
- **Telemetry**: recordAutoManage() called with same metadata

---

## Migration & Backward Compatibility

✅ **No breaking changes**
- Existing calls without `force` param work as before
- POST body still accepts `{force: true}`
- Response type extended (optional `forced` field)
- All quantization transparent to callers

---

## Next Steps

1. **Deploy to staging** - Test force=1 during after-hours
2. **Monitor logs** - Watch for quantization notes in /api/auto-manage/run responses
3. **Verify Alpaca** - Confirm no more 42210000 errors (sub-penny rejects)
4. **Production rollout** - Enable for scheduled after-hours runs if needed
