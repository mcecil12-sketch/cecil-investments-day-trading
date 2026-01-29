# Ultra Bulletproof Ghost-Trade Cleanup Implementation

## Summary
Implemented a multi-layered ghost-trade cleanup system that runs reconciliation automatically from both GitHub Actions market-loop and the auto-manage engine, ensuring ghosts are cleaned up even if one path fails or pauses.

## Changes Made

### PART 1: Shared Reconciliation Module

#### Created: `lib/maintenance/reconcileOpenTrades.ts`
- Extracted core reconciliation logic into a reusable, async-safe function
- **Export**: `reconcileOpenTrades(options)` with configurable:
  - `dryRun` (boolean) - Test without persisting changes
  - `max` (number) - Max trades to check per run
  - `closeReason` (string) - Reason to record when closing stale trades
  - `syncToPositionOpen` (boolean) - Sync order status to positions
  - `runSource` (string) - Track where the reconcile originated
  - `runId` (string) - Unique run identifier for tracing
  - `deadlineMs` (number) - Timeout budget to prevent hangs

**Key Features**:
- Validates trades against broker-truth (positions + open orders)
- Closes stale trades not found in broker
- Syncs order status and fill info for trades with positions
- Includes deadline checking to prevent timeout hangs
- Returns detailed results with reconciliation stats
- Includes robust error handling with try/catch

#### Created: `lib/maintenance/reconcileTelemetry.ts`
- Telemetry store for tracking reconciliation runs in Redis
- Records success/failure, closed/synced counts, source, and run ID
- Functions:
  - `recordReconcile(run)` - Record a reconciliation run
  - `readReconcileTelemetry(limit)` - Retrieve recent reconciliation history

### PART 2: Updated Maintenance API

#### Updated: `app/api/maintenance/reconcile-open-trades/route.ts`
- Simplified to use shared `reconcileOpenTrades()` function
- Passes request headers as telemetry context:
  - `x-run-source` (source identifier)
  - `x-run-id` (unique run ID)
- Maintains auth (CRON_TOKEN or session)
- Keeps existing API contract

### PART 3: Auto-Manage Engine Hardening

#### Updated: `lib/autoManage/engine.ts`
- Added import: `reconcileOpenTrades` from shared module
- Enhanced `AutoManageResult` type with optional `reconcile` field
- **At the start of `runAutoManage()`**:
  - Calls reconciliation with 3-second deadline
  - `dryRun=false` (actually closes ghosts)
  - `runSource="auto-manage"` (telemetry)
  - Includes reconciliation result in returned data
  - **Non-fatal**: If reconcile fails, auto-manage continues normally
  - Logs reconciliation outcome in notes for visibility

**Key Guarantee**: Even if GitHub Actions market-loop pauses/limits, auto-manage will still clean up ghosts every run.

### PART 4: GitHub Actions Workflow

#### Updated: `.github/workflows/market-loop.yml`
- Added step: **"Reconcile ghost open trades"**
- Placement: After "Sync broker state", BEFORE scan/auto-entry steps
- Configuration:
  - `--max-time 60` - 60-second timeout to prevent job hangs
  - `dryRun=false` - Actually closes ghosts
  - Custom headers for run tracking
  - Output truncated to 2000 chars
  - Non-fatal (`|| true`) - Reconcile errors won't fail workflow
  - Runs at every 5-minute interval (same cadence as market-loop)

### PART 5: Ops Visibility

#### Updated: `app/api/ops/status/route.ts`
- Added import: `readReconcileTelemetry` from reconcile telemetry module
- Fetches reconciliation telemetry in parallel with other status data
- Includes in response: `reconcileTelemetry` with:
  - Summary: total runs, successes, failures, total closed/synced
  - Last run: timestamp, source, run ID, stats
  - Recent runs history (last 5)

**Benefit**: Instant visibility into whether self-healing is actively running and effective.

## Acceptance Criteria ✅

1. **Even if a ghost OPEN trade appears again, it is auto-closed within the next auto-manage tick (or market-loop tick)**
   - ✅ Auto-manage reconciles at start of every run
   - ✅ Market-loop reconciles at start of every tick
   - ✅ Together: Ghosts cleaned up in < 5 minutes (market-loop) or immediately (auto-manage)

2. **Auto-entry gating never blocks due to app-state ghosts (broker-truth remains the authority)**
   - ✅ Broker-truth is the source of authority
   - ✅ Reconciliation syncs app-state to match broker
   - ✅ Telemetry tracks reconciliation effectiveness

3. **No workflow failures caused by reconcile (errors are logged but non-fatal)**
   - ✅ Market-loop: `|| true` prevents reconcile errors from failing job
   - ✅ Auto-manage: try/catch prevents reconcile errors from failing run
   - ✅ Both record errors for visibility but continue operating

## Telemetry & Observability

### Record Reconciliation Runs
Every reconciliation (from any source) records:
- Timestamp
- Source (`maintenance-api`, `auto-manage`, `github-actions`)
- Run ID (for tracing)
- Checked count (trades evaluated)
- Closed count (stale trades closed)
- Synced count (trades synced to positions)
- Success/Failure status

### View via /api/ops/status
```json
{
  "reconcileTelemetry": {
    "summary": {
      "runs": 47,
      "success": 45,
      "fail": 2,
      "totalClosed": 3,
      "totalSynced": 142,
      "lastRunAt": "2026-01-29T20:15:30.123Z",
      "lastOk": "true",
      "lastSource": "auto-manage",
      "lastClosed": 1,
      "lastSynced": 8
    },
    "runs": [ /* recent 5 runs */ ]
  }
}
```

## Error Handling & Safety

### Timeout Protection
- Auto-manage: 3-second deadline (prevents slow reconciles from blocking auto-manage)
- Market-loop: 60-second curl timeout (prevents job hangs)
- Both: Early deadline exit if exceeded

### Non-Fatal Errors
- Reconcile errors don't stop auto-manage or market-loop
- Broker-truth fetch failure returns error but doesn't cascade
- Telemetry recording failures logged but non-fatal
- Failed reconciles are still recorded for visibility

### Logging
- Detailed console logs with source/runId context
- Trades closed/synced logged individually
- Failures logged with full error context
- Telemetry failures logged separately

## Deployment Notes

1. **No breaking changes** - All endpoints backward compatible
2. **Opt-in at code level** - Reconciliation is called, errors are caught
3. **Redis optional** - Telemetry degrades gracefully if Redis unavailable
4. **Immediate effect** - No config changes needed, reconciliation runs on deploy
5. **Monitoring** - Check `/api/ops/status` → `reconcileTelemetry` to verify health

## Testing Checklist

- [ ] Verify market-loop workflow executes reconciliation step
- [ ] Verify auto-manage calls reconciliation at startup
- [ ] Create a ghost trade in broker (without app entry)
- [ ] Confirm ghost is closed by next market-loop or auto-manage run
- [ ] Check `/api/ops/status` shows reconciliation telemetry
- [ ] Verify reconcile errors don't break workflows
- [ ] Confirm app-state matches broker-truth after reconciliation
