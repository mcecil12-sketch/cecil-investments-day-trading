# Stop Rescue Failsafe - Telemetry & Monitoring Quick Reference

## Where Telemetry is Recorded

### 1. Redis Summary (Persistent Metrics)
**Key**: `telemetry:auto-manage:summary` (Hash)

**New Fields**:
```
rescueAttempted     (integer) Total cumulative rescue attempts
rescueOk            (integer) Total cumulative successful rescues  
rescueFailed        (integer) Total cumulative failed rescues
lastRescueAttempted (integer) Rescues in most recent run
lastRescueOk        (integer) Successful rescues in most recent run
lastRescueFailed    (integer) Failed rescues in most recent run
```

### 2. Redis Runs History (Per-Run Details)
**Key**: `telemetry:auto-manage:runs` (List, max 200 most recent)

**Each entry includes**:
```json
{
  "ts": "2026-01-31T15:30:45.123Z",
  "outcome": "SUCCESS",
  "checked": 5,
  "updated": 2,
  "flattened": 0,
  "rescueAttempted": 1,
  "rescueOk": 1,
  "rescueFailed": 0,
  "source": "auto-manage",
  "runId": "auto-manage-run-123"
}
```

### 3. Per-Trade Fields (In trades.json)
**Location**: Each trade's `autoManage` object

```json
{
  "id": "trade-001",
  "ticker": "AAPL",
  "status": "OPEN",
  "autoManage": {
    "lastStopRescueAt": "2026-01-31T15:30:45.123Z",
    "lastStopRescueStatus": "OK",
    "lastStopRescueError": null,
    "lastRunAt": "2026-01-31T15:30:45.123Z",
    "lastRule": "BE_1R",
    "trailEnabled": true,
    "lastStopSyncAt": "2026-01-31T15:30:45.123Z",
    "lastStopSyncStatus": "OK"
  },
  "stopOrderId": "order-12345"
}
```

### 4. Operational Notes (Console Output)
**Location**: Run result `notes` array (max 50 most recent)

**Rescue-Related Patterns**:
```
stop_rescue_ok:AAPL:stop_rescued: order-12345
stop_rescue_fail:AAPL:stop_rescue_failed: unable_to_determine_qty: no_open_position
stop_rescue_exception:AAPL:Network timeout
```

## How to Query Telemetry

### Redis CLI Examples

**Get Summary Statistics**:
```bash
redis-cli HGETALL telemetry:auto-manage:summary
# Output:
# rescueAttempted: 15
# rescueOk: 14
# rescueFailed: 1
# lastRescueAttempted: 2
# lastRescueOk: 2
# lastRescueFailed: 0
```

**Get Last 10 Runs**:
```bash
redis-cli LRANGE telemetry:auto-manage:runs 0 9
```

**Get Rescue Success Rate**:
```bash
redis-cli HGETALL telemetry:auto-manage:summary | grep -E 'rescueOk|rescueAttempted'
# Manual calculation: rescueOk / rescueAttempted
```

**Get Last Run with Rescue Activity**:
```bash
redis-cli LRANGE telemetry:auto-manage:runs 0 0
# Parse JSON and check rescueAttempted, rescueOk, rescueFailed
```

### Code Examples

**In TypeScript/Node**:
```typescript
import { redis } from "@/lib/redis";

// Get summary
const summary = await redis.hgetall("telemetry:auto-manage:summary");
console.log("Total rescues:", summary.rescueOk, "/", summary.rescueAttempted);

// Get last 5 runs
const runs = await redis.lrange("telemetry:auto-manage:runs", 0, 4);
const parsed = runs.map(r => JSON.parse(r));
console.log("Recent runs:", parsed);

// Filter runs with rescue activity
const runsWithRescue = parsed.filter(r => r.rescueAttempted > 0);
```

**Read from trades.json**:
```typescript
import { readTrades } from "@/lib/tradesStore";

const trades = await readTrades();
trades.forEach(t => {
  if (t.autoManage?.lastStopRescueAt) {
    console.log(`${t.ticker}: rescue at ${t.autoManage.lastStopRescueAt}, status=${t.autoManage.lastStopRescueStatus}`);
  }
});
```

## Telemetry Analysis Scenarios

### Scenario 1: Monitor Success Rate Degradation
```
Alert if: rescueOk / rescueAttempted < 95% over last 1 hour
Action: Check Alpaca API status, network connectivity, tick size issues
```

### Scenario 2: Spike in Rescue Attempts
```
Alert if: rescueAttempted increases suddenly (e.g., > 5 in single run)
Action: Check if stops are being canceled unexpectedly, market volatility
```

### Scenario 3: Specific Error Trending
```
Monitor: rescueFailed breakdown by error type
- "unable_to_determine_qty": position query failures
- "no_open_position": expected for closed trades
- "stop_normalization_failed": tick size issues
- "stop_rescue_error": network/API errors
```

### Scenario 4: Per-Trade Rescue History
```
Query: trades where lastStopRescueStatus = "FAIL"
Action: Investigate if specific tickers or conditions cause failures
```

### Scenario 5: Rescue Latency
```
Measure: Time between trade entry and lastStopRescueAt
Alert if: > 30 seconds (suggests auto-manage not running frequently enough)
```

## Telemetry Data Schema

### AutoManageRun (Per-Run Record)
```typescript
{
  ts: string;              // ISO timestamp of run
  outcome: "SUCCESS" | "FAIL" | "SKIP";
  reason?: string;         // Why run succeeded/failed/skipped
  checked?: number;        // Trades checked in this run
  updated?: number;        // Trades updated in this run
  flattened?: number;      // Trades flattened at EOD
  rescueAttempted?: number;// New: rescue attempts this run
  rescueOk?: number;       // New: successful rescues this run
  rescueFailed?: number;   // New: failed rescues this run
  source?: string;         // "auto-manage", "manual", etc
  runId?: string;          // Unique run identifier
}
```

### Trade.AutoManage Object (Per-Trade History)
```typescript
{
  lastRunAt?: string;              // Most recent run timestamp
  lastRule?: string;               // Last rule applied: "NONE" | "BE_1R" | "LOCK_2R"
  lastStopSyncAt?: string;         // Last stop sync attempt
  lastStopSyncStatus?: "OK" | "FAIL";
  lastStopSyncError?: string;      // Error detail if sync failed
  lastStopSyncCancelled?: string[];// Orders cancelled during sync
  lastStopRescueAt?: string;       // New: last rescue attempt
  lastStopRescueStatus?: "OK" | "FAIL";  // New: rescue outcome
  lastStopRescueError?: string;    // New: rescue error detail
  trailEnabled?: boolean;          // Trailing stop enabled
  eodFlattenedAt?: string;         // EOD flatten timestamp
  forcedSyncAt?: string;           // Force sync timestamp
}
```

## Common Queries

### "How many stops have been rescued?"
```typescript
const summary = await redis.hgetall("telemetry:auto-manage:summary");
const totalRescued = Number(summary.rescueOk);
console.log(`Total stops rescued: ${totalRescued}`);
```

### "What's the current rescue success rate?"
```typescript
const s = await redis.hgetall("telemetry:auto-manage:summary");
const rate = (Number(s.rescueOk) / Number(s.rescueAttempted) * 100).toFixed(1);
console.log(`Success rate: ${rate}%`);
```

### "Show trades that needed rescue recently"
```typescript
const trades = await readTrades();
const rescued = trades.filter(t => t.autoManage?.lastStopRescueAt);
rescued.forEach(t => {
  console.log(`${t.ticker}: ${t.autoManage.lastStopRescueStatus}`);
});
```

### "What errors are happening in rescues?"
```typescript
const trades = await readTrades();
const failures = trades.filter(t => t.autoManage?.lastStopRescueStatus === "FAIL");
const errors = failures.map(t => ({
  ticker: t.ticker,
  error: t.autoManage.lastStopRescueError,
  time: t.autoManage.lastStopRescueAt
}));
console.table(errors);
```

### "Show last 5 runs with rescue activity"
```typescript
const runs = await redis.lrange("telemetry:auto-manage:runs", 0 99);
const parsed = runs.map(r => JSON.parse(r));
const withRescue = parsed.filter(r => r.rescueAttempted).slice(0, 5);
console.table(withRescue.map(r => ({
  time: r.ts,
  outcome: r.outcome,
  attempted: r.rescueAttempted,
  ok: r.rescueOk,
  failed: r.rescueFailed
})));
```

## Integration Points

### 1. API Endpoint for Telemetry (Create if needed)
**Suggested Path**: `/api/admin/telemetry/stop-rescue`

**Query Parameters**:
- `limit`: number of recent runs to return (default: 20)
- `ticker`: filter by specific ticker (optional)

**Response**:
```json
{
  "ok": true,
  "summary": {
    "rescueAttempted": 42,
    "rescueOk": 40,
    "rescueFailed": 2,
    "lastRescueAttempted": 3,
    "lastRescueOk": 3,
    "lastRescueFailed": 0
  },
  "recentRuns": [
    {
      "ts": "2026-01-31T15:30:45Z",
      "rescueAttempted": 3,
      "rescueOk": 3,
      "rescueFailed": 0
    }
  ],
  "tradesNeedingRescue": [
    {
      "ticker": "AAPL",
      "status": "OPEN",
      "lastRescueStatus": "OK",
      "lastRescueAt": "2026-01-31T15:30:45Z"
    }
  ]
}
```

### 2. UI Display Components
- **Dashboard Card**: Show rescue success rate (last 24 hours)
- **Trade Details**: Show `lastStopRescueStatus` and `lastStopRescueAt`
- **Run History**: Show `rescueAttempted`/`rescueOk`/`rescueFailed` per run
- **Alerts**: Alert when rescue fails or success rate drops

### 3. Logging & Audit Trail
All rescue events logged to:
- Console: `[autoManage] stop_rescue_*` patterns
- Redis: Persistent in `telemetry:auto-manage:runs` list
- Trades JSON: Per-trade history in `autoManage` object

---

**Last Updated**: January 31, 2026  
**Implementation**: Stop Rescue Failsafe v1.0
