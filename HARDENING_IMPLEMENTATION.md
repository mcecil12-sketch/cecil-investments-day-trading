# Hardening Implementation Summary: "No Activity" Fix

## Objective Completed ✅
Permanently fix "no activity" by hardening (A) auto-entry gating to use Alpaca broker-truth positions, and (B) AI scoring to always drain PENDING signals with explicit diagnostics.

---

## A) Broker-Truth for Entry Gating (Fix Ghost/Stale Blocking)

### 1. New Module: `lib/broker/truth.ts`
**Purpose:** Single source of truth for broker state. Fetches real Alpaca positions and open orders with safe error handling and caching.

**Key Features:**
- **Fetch Methods:**
  - `GET /v2/positions` → returns symbol, qty
  - `GET /v2/orders?status=open` → returns id, symbol, side, status
- **Type Export:**
  ```typescript
  export type BrokerTruth = {
    fetchedAt: string
    positionsCount: number
    openOrdersCount: number
    positions: Array<{ symbol: string; qty: number }>
    openOrders: Array<{ id: string; symbol: string; side: string; status: string }>
    error?: string
  }
  ```
- **Safety Features:**
  - 10-second timeout per API call
  - Try/catch wrapping all operations
  - Redis cache for 45 seconds to avoid hammering Alpaca
  - Graceful error reporting included in response

### 2. Updated: `app/api/auto-entry/execute/route.ts`
**Changes:**
- Import `fetchBrokerTruth`
- Fetch broker truth at start (parallel with guard state)
- **New check:** Use `brokerTruth.positionsCount` instead of internal trade count for `max_open_positions` gating
- **Error handling:** If broker truth fails, skip with reason `broker_truth_unavailable` (don't block indefinitely)
- **Telemetry:** Include `brokerPositionsCount` and `maxOpenPositions` in detail field

**Updated Type:**
```typescript
type GuardSummary = {
  // ... existing fields ...
  brokerPositionsCount?: number
  brokerOpenOrdersCount?: number
  brokerTruthError?: string
}
```

### 3. Updated: `lib/autoEntry/telemetry.ts`
**Changes:**
- Added `detail?: string` field to `AutoEntryTelemetryEvent`
- Store `lastDetail` in telemetry hash for diagnostics

**Outcome:** When entry is skipped for `max_open_positions`, telemetry shows:
```
detail: "brokerPositionsCount=3, maxOpenPositions=3"
```

---

## B) Scoring Drain Job (Fix 200 PENDING / 0 SCORED)

### 4. New Endpoint: `POST /api/ai/score/drain?limit=25`
**Location:** `app/api/ai/score/drain/route.ts`

**Purpose:** Continuously drain PENDING signals queue to prevent permanent backlog.

**Key Features:**
- **Authorization:** Requires `x-cron-token` (same as cron endpoints)
- **Locking:** Acquires Redis lock (30s TTL) to prevent parallel drains
- **Batch Processing:**
  - Finds PENDING signals from last 24 hours (recent first)
  - Scores up to `limit` (default 25, max 100)
  - Atomically updates each signal
- **Status Handling:**
  - Marks as `SCORED` with AI score/grade on success
  - Marks as `ERROR` with error reason on failure
  - **Never leaves signals PENDING forever**
- **Funnel Tracking:**
  - Updates `gptScored`, `qualified`, `shownInApp` counters
  - Bumps AI heartbeat for health tracking
- **Response Telemetry:**
  ```json
  {
    "ok": true,
    "drain": {
      "processed": 25,
      "scored": 24,
      "errors": 1,
      "details": [
        {
          "id": "SIGNAL_ID",
          "ticker": "AAPL",
          "status": "SCORED",
          "aiScore": 7.5
        }
      ],
      "completedAt": "...",
      "durationMs": 1234
    }
  }
  ```

---

## C) Diagnostics Endpoint

### 7. New/Updated: `GET /api/ops/status`
**Location:** `app/api/ops/status/route.ts`

**Purpose:** Comprehensive health check revealing exactly why there are no orders or why signals are pending.

**Response Structure:**
```typescript
{
  ok: true,
  generatedAt: "2025-01-29T...",
  durationMs: 156,

  // Market status
  market: { isOpen, nextOpen, nextClose },

  // Broker truth snapshot
  broker: {
    fetchedAt: "...",
    positionsCount: 2,
    openOrdersCount: 1,
    error: null,
    positions: [{ symbol: "AAPL", qty: 100 }],
    openOrders: [{ id: "...", symbol: "AAPL", side: "buy", status: "pending_new" }]
  },

  // Entry gating configuration
  entryGating: {
    enabled: true,
    maxOpenPositions: 3,
    maxEntriesPerDay: 5,
    cooldownAfterLossMin: 20,
    ...
  },

  // Entry state & decision
  entryState: {
    wouldSkipMaxOpenPositions: false,
    reason: "READY",
    guardState: {
      entriesToday: 2,
      consecutiveFailures: 0,
      lastLossAt: null,
      autoDisabledReason: null
    },
    openTrades: { total: 3, fromAutoEntry: 2 }
  },

  // Scoring backlog (critical for debugging)
  scoring: {
    last6Hours: {
      total: 50,
      pending: 5,      // ← Should be 0 after drain
      scored: 40,
      error: 5,
      backlog: 5
    },
    allTime: { ... }
  },

  // Last auto-entry run
  lastAutoEntry: {
    at: "...",
    outcome: "SKIP",
    reason: "max_open_positions",
    detail: "brokerPositionsCount=3, maxOpenPositions=3"
  },

  // Quick health assessment
  health: {
    brokerConnected: true,
    scoringHealthy: true,  // ← false if >50 pending+error
    entryReadiness: true
  }
}
```

---

## D) Reconcile Hardening

### 8. Updated: `app/api/maintenance/reconcile-open-trades/route.ts`
**Changes:**
- Use `fetchBrokerTruth()` as authoritative source instead of separate API calls
- Fail early if broker truth unavailable (returns 500)
- Better logging when closing stale trades
- Response includes broker truth metadata:
  ```json
  {
    "broker": {
      "positionsCount": 5,
      "openOrdersCount": 3,
      "fetchedAt": "..."
    }
  }
  ```

**Reconciliation Logic:**
1. Get broker truth (positions + open orders)
2. For each OPEN trade:
   - If not in broker positions AND not in broker open orders → mark CLOSED
   - Else if position exists → sync order status
   - Else → keep as-is
3. Update trades with broker state

**Result:** Stale app state (from failed orders, ghost trades) is cleaned up, freeing up `max_open_positions` slots.

---

## E) GitHub Actions Workflows

### 5. New Workflow: `.github/workflows/score-drain.yml`
**Schedule:** Every 5 minutes during market hours (1:00 PM - 4:00 PM ET, Mon-Fri)

**Job:**
- Calls `POST /api/ai/score/drain?limit=25`
- Passes `x-cron-token`
- Logs response (processed, scored, errors)
- Non-fatal failures (continues on 429 or errors)

**Expected Outcome:** PENDING signals drain at ~125/hour (25 per 5 min), never accumulate to 200+.

### 6. Updated: `.github/workflows/market-loop.yml`
**Change:** Fixed cron schedule from `*/2` to `*/5` (GitHub Actions minimum is 5 minutes).

---

## Expected Results

### Before Fix:
- **No Activity Issue:** Orders placed, but app shows pending=200, scored=0
- **Root Causes:**
  1. Ghost positions in app state block entry
  2. PENDING signals never drained → clog system
  3. No visibility into why entry is skipped

### After Fix:
✅ **Auto-Entry Gating:**
- Entry skip reason explicit in telemetry + `/api/ops/status`
- Only real broker positions count (no ghost blocking)
- Failed reconciliation cleans up stale trades

✅ **Scoring Drain:**
- Automated job runs every 5 minutes
- Processes up to 25 signals per run
- Never leaves signals PENDING forever
- Explicit ERROR marks for failed scores

✅ **Diagnostics:**
- `/api/ops/status` shows exact reason for skips
- Broker connection status visible
- Scoring backlog counts available
- Last auto-entry run reason + detail included

---

## Testing Checklist

- [ ] Deploy `lib/broker/truth.ts`
- [ ] Deploy auto-entry changes (uses broker truth)
- [ ] Deploy drain endpoint `/api/ai/score/drain`
- [ ] Deploy `/api/ops/status` updates
- [ ] Deploy reconcile updates
- [ ] Enable score-drain workflow
- [ ] Monitor `/api/ops/status` during market hours
- [ ] Verify `scoring.last6Hours.backlog` decreases
- [ ] Verify `entryState.wouldSkipMaxOpenPositions` matches broker reality
- [ ] Check auto-entry telemetry includes broker detail

---

## Configuration

No new environment variables required. System uses existing:
- `CRON_TOKEN` for endpoint authorization
- `ALPACA_*` keys for broker access
- `REDIS_*` for caching and locking
- `AUTO_ENTRY_MAX_OPEN_POSITIONS` for gating threshold

Optional Monitoring:
- Set alert if `/api/ops/status` → `health.scoringHealthy` = false
- Set alert if `/api/ops/status` → `scoring.last6Hours.backlog` > 10
- Set alert if `/api/ops/status` → `broker.error` is not null

---

## Files Modified/Created

**Created:**
- `lib/broker/truth.ts` - Broker truth module
- `app/api/ai/score/drain/route.ts` - Drain endpoint
- `.github/workflows/score-drain.yml` - Drain automation

**Updated:**
- `app/api/auto-entry/execute/route.ts` - Use broker truth for max positions
- `app/api/ops/status/route.ts` - Comprehensive diagnostics
- `app/api/maintenance/reconcile-open-trades/route.ts` - Use broker truth
- `lib/autoEntry/telemetry.ts` - Add detail field
- `.github/workflows/market-loop.yml` - Fix cron schedule

---

## Notes

- **Broker truth caching (45s):** Prevents hammering Alpaca during high-frequency runs
- **Drain lock (30s):** Prevents overlapping drain runs from concurrent triggers
- **24-hour window:** Drain only processes signals from last 24 hours (prevents reprocessing old signals)
- **Signal status → ERROR:** Failed scores now marked ERROR with reason, freeing pipeline
- **Reconcile timing:** Safe to run frequently; only modifies stale trades

This implementation ensures **entry gating is always correct** and **PENDING signals never accumulate permanently**.
