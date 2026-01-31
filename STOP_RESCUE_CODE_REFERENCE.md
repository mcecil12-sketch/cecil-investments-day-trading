# Stop Rescue Failsafe - Code Reference

## New Functions & Types

### [lib/autoManage/stopSync.ts](lib/autoManage/stopSync.ts)

#### Type: `StopRescueResult`
```typescript
export type StopRescueResult =
  | { ok: true; stopOrderId: string; reason: string }
  | { ok: false; error: string; detail?: string };
```

#### Function: `rescueStop(trade: TradeLike)`
**Purpose**: Create a standalone GTC stop order when protection is missing

**Input**: 
- `trade` - Trade object with ticker, side, stopPrice, qty, broker position info

**Output**:
- Success: `{ ok: true, stopOrderId: string, reason: "standalone_gtc_stop_created" }`
- Failure: `{ ok: false, error: string, detail?: string }`

**Errors**:
- `invalid_trade_ticker_or_side` - Missing or invalid ticker/side
- `missing_stopPrice` - Stop price not available on trade
- `unable_to_determine_qty` - Cannot determine order quantity
- `no_open_position` - No broker position found
- `stop_normalization_failed` - Tick size validation failed
- `stop_order_missing_id` - Alpaca didn't return order ID
- `stop_rescue_error` - Network or unexpected error

**Key Behavior**:
```typescript
// 1. Validate trade data
// 2. Get broker position (fallback if qty not on trade)
// 3. Normalize stop price for tick compliance
// 4. Create GTC order (does NOT cancel anything)
// 5. Extract and validate order ID from response
// 6. Return only if ID successfully obtained
```

#### Function: `isStopOrderActive(orderId: string)`
**Purpose**: Check if a stop order is currently active in Alpaca

**Input**: Order ID to check

**Output**: `true` if active, `false` if not found or inactive

**Active States**: `"pending"`, `"accepted"`, `"held"`

**Safe**: Returns `false` on any error (no exception thrown)

---

### [lib/autoManage/engine.ts](lib/autoManage/engine.ts)

#### Function: `ensureStopRescued(trade, now, ticker)`
**Purpose**: Decision logic - determine if rescue is needed and attempt it

**Signature**:
```typescript
async function ensureStopRescued(
  trade: any, 
  now: string, 
  ticker: string
): Promise<{
  rescueAttempted: boolean;
  rescueOk?: boolean;
  rescueNote?: string;
}>
```

**Logic**:
```
1. Check if trade.stopOrderId exists
   ├─ YES: return { rescueAttempted: false }  (assume active)
   └─ NO:  proceed to step 2

2. Query broker positions for ticker
   ├─ Error: return { rescueAttempted: true, rescueOk: false, ... }
   └─ Success: proceed to step 3

3. Check position qty
   ├─ qty <= 0: return { rescueAttempted: false }  (no position, no rescue)
   └─ qty > 0:  proceed to step 4

4. Attempt rescue via rescueStop(trade)
   ├─ Success: return { rescueAttempted: true, rescueOk: true, rescueNote: ... }
   └─ Failure: return { rescueAttempted: true, rescueOk: false, rescueNote: ... }
```

**Return Values**:
- `rescueAttempted: false` - No rescue needed (has stop or no position)
- `rescueAttempted: true, rescueOk: true` - Successful rescue
- `rescueAttempted: true, rescueOk: false` - Failed rescue

---

## Integration Points

### In Auto-Manage Loop (engine.ts ~line 250)

```typescript
// STOP RESCUE FAILSAFE: ensure there's always an active protective stop
let rescueAttemptedLocal = false;
let rescueOkLocal = false;
let rescueNote = "";
try {
  const rescueResult = await ensureStopRescued(next[idx], now, ticker);
  rescueAttemptedLocal = rescueResult.rescueAttempted;
  rescueOkLocal = rescueResult.rescueOk;
  rescueNote = rescueResult.rescueNote || "";

  if (rescueAttemptedLocal) {
    rescueAttempted++;
    if (rescueOkLocal) {
      rescueOk++;
      // Extract stopOrderId from note: "stop_rescued: order-id"
      next[idx] = {
        ...next[idx],
        stopOrderId: rescueNote.split(": ")[1],
        autoManage: {
          ...(next[idx].autoManage || {}),
          lastStopRescueAt: now,
          lastStopRescueStatus: "OK",
        },
        updatedAt: now,
      };
      notes.push(`stop_rescue_ok:${ticker}:${rescueNote}`);
      updated++;
    } else {
      rescueFailed++;
      next[idx] = {
        ...next[idx],
        autoManage: {
          ...(next[idx].autoManage || {}),
          lastStopRescueAt: now,
          lastStopRescueStatus: "FAIL",
          lastStopRescueError: rescueNote,
        },
        updatedAt: now,
      };
      notes.push(`stop_rescue_fail:${ticker}:${rescueNote}`);
      hadFailures = true;
    }
  }
} catch (rescueErr: any) {
  notes.push(`stop_rescue_exception:${ticker}:${String(rescueErr?.message || rescueErr)}`);
}
```

### Telemetry Recording (engine.ts ~line 380)

```typescript
await recordAutoManage({
  ts: now,
  outcome: hadFailures ? "FAIL" : "SUCCESS",
  reason: hadFailures ? "stop_sync_failed" : undefined,
  source: opts.source,
  runId: opts.runId,
  checked,
  updated,
  flattened,
  rescueAttempted: rescueAttempted || undefined,
  rescueOk: rescueOk || undefined,
  rescueFailed: rescueFailed || undefined,
});
```

---

## Data Flow Diagram

```
Auto-Manage Run
├─ For each OPEN trade:
│  ├─ Get latest quote
│  ├─ Compute nextStop based on rules (1R, 2R, trail)
│  │
│  ├─→ [STOP RESCUE GUARD] ← NEW!
│  │   ├─→ ensureStopRescued(trade)
│  │   │   ├─→ Check if stopOrderId exists
│  │   │   ├─→ getPositions(ticker) if not
│  │   │   └─→ Call rescueStop() if position exists
│  │   │       ├─→ normalizeStopPrice()
│  │   │       ├─→ createOrder() [GTC]
│  │   │       ├─→ Extract order ID
│  │   │       └─→ Return result
│  │   └─→ Update trade if successful
│  │
│  ├─→ [NORMAL STOP SYNC]
│  │   ├─→ syncStopForTrade() if stop changed
│  │   ├─→ May cancel/replace old stops
│  │   └─→ Persist new stopOrderId
│  │
│  └─→ Update metrics, notes
│
├─ Write updated trades
├─ Record telemetry (with rescue counts)
└─ Return summary
```

---

## Error Handling Examples

### Example 1: Position Query Fails
```typescript
// In ensureStopRescued()
try {
  const positions = await getPositions(ticker);
  // ...
} catch (err: any) {
  return {
    rescueAttempted: true,
    rescueOk: false,
    rescueNote: `stop_rescue_error: ${String(err.message || err)}`,
  };
}
```

### Example 2: Order Creation Fails
```typescript
// In rescueStop()
try {
  const stopOrder = await createOrder({...});
  // Extract ID logic
} catch (err: any) {
  return {
    ok: false,
    error: "stop_rescue_error",
    detail: err?.message ?? String(err),
  };
}
```

### Example 3: Non-Fatal Failure
```typescript
// In engine loop
if (rescueAttemptedLocal && !rescueOkLocal) {
  rescueFailed++;
  // Update trade with error
  next[idx].autoManage.lastStopRescueError = rescueNote;
  // Mark run as having failures (but don't crash)
  hadFailures = true;
  // Continue processing next trade
}
```

---

## Type Definitions

### AutoManageRun (Updated)
```typescript
export type AutoManageRun = {
  ts: string;              // ISO timestamp
  outcome: AutoManageOutcome;  // "SUCCESS" | "FAIL" | "SKIP"
  reason?: string;
  checked?: number;        // Trades checked
  updated?: number;        // Trades updated
  flattened?: number;      // Trades flattened at EOD
  rescueAttempted?: number;  // ← NEW: rescue attempts
  rescueOk?: number;         // ← NEW: successful rescues
  rescueFailed?: number;     // ← NEW: failed rescues
  source?: string;
  runId?: string;
};
```

### Trade.autoManage (Updated)
```typescript
{
  lastRunAt?: string;
  lastRule?: string;  // "NONE" | "BE_1R" | "LOCK_2R"
  lastStopSyncAt?: string;
  lastStopSyncStatus?: "OK" | "FAIL";
  lastStopSyncError?: string;
  lastStopSyncCancelled?: string[];
  
  // ← NEW rescue fields:
  lastStopRescueAt?: string;      // When rescue was attempted
  lastStopRescueStatus?: "OK" | "FAIL";  // Outcome
  lastStopRescueError?: string;   // Error detail if failed
  
  trailEnabled?: boolean;
  eodFlattenedAt?: string;
  forcedSyncAt?: string;
}
```

---

## Testing Checklist

- [ ] Test rescue triggered when position exists, stopOrderId missing
- [ ] Test rescue skipped when stopOrderId already exists
- [ ] Test rescue skipped when position closed (qty = 0)
- [ ] Test error handling: position query fails → rescue fails but trade OK
- [ ] Test error handling: order creation fails → lastStopRescueError set
- [ ] Test tick normalization: sub-penny stop normalized before submission
- [ ] Test atomicity: stopOrderId only set after Alpaca confirms
- [ ] Test telemetry: rescueAttempted/rescueOk/rescueFailed tracked
- [ ] Test idempotency: running rescue twice doesn't create duplicate stops
- [ ] Test non-fatal: rescue failure doesn't crash auto-manage run
- [ ] Test multiple rescues in one run: metrics accumulate correctly
- [ ] Test Redis telemetry persistence: metrics stored and queryable

---

## Common Queries

### Query: Get all trades that needed rescue
```typescript
const trades = await readTrades();
const rescued = trades.filter(t => t.autoManage?.lastStopRescueAt);
rescued.forEach(t => console.log(`${t.ticker}: ${t.autoManage.lastStopRescueStatus}`));
```

### Query: Get rescue success rate
```typescript
const s = await redis.hgetall("telemetry:auto-manage:summary");
const rate = (Number(s.rescueOk) / Number(s.rescueAttempted) * 100);
console.log(`Rescue success rate: ${rate}%`);
```

### Query: Get recent rescue failures
```typescript
const trades = await readTrades();
const failures = trades.filter(t => t.autoManage?.lastStopRescueStatus === "FAIL");
failures.forEach(t => {
  console.log(`${t.ticker}: ${t.autoManage.lastStopRescueError}`);
});
```

### Query: Get last run with rescue activity
```typescript
const runs = await redis.lrange("telemetry:auto-manage:runs", 0, 0);
const [lastRun] = runs.map(r => JSON.parse(r));
console.log(`Rescues: ${lastRun.rescueAttempted} attempted, ${lastRun.rescueOk} ok, ${lastRun.rescueFailed} failed`);
```

---

## Performance Notes

- **Per-Trade Cost**: 1 broker API call (getPositions) + 1 order creation if rescue needed
- **Caching**: Position queries could be cached across batch processing
- **Parallelization**: All rescue attempts await in sequence (same as sync logic)
- **Memory**: Negligible (telemetry fields added to existing objects)
- **Redis**: Async telemetry recording (non-blocking)

---

## Related Documentation

- [STOP_RESCUE_IMPLEMENTATION.md](STOP_RESCUE_IMPLEMENTATION.md) - Full implementation details
- [STOP_RESCUE_TELEMETRY.md](STOP_RESCUE_TELEMETRY.md) - Telemetry & monitoring guide
- [STOP_RESCUE_SUMMARY.md](STOP_RESCUE_SUMMARY.md) - Executive summary
- [lib/autoManage/config.ts](lib/autoManage/config.ts) - Configuration
- [lib/tickSize.ts](lib/tickSize.ts) - Tick size normalization
- [lib/broker/truth.ts](lib/broker/truth.ts) - Broker position fetching

---

**Implementation Date**: January 31, 2026  
**Code Reference Version**: 1.0
