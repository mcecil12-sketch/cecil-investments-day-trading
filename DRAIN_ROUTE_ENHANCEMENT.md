# Drain Route Enhancement - Complete Implementation

**Date**: January 30, 2026  
**Goal**: Increase GPT scoring throughput to 250–400 scores/day during market hours via concurrent scoring with raised time budget.

---

## Changes Implemented

### 1. Increased Internal Time Budget

**File**: `app/api/ai/score/drain/route.ts` (Lines 14-16)

```typescript
// DEADLINE_MS is the internal time budget; we soft-stop at ~8s before this to avoid hard timeout
const DEADLINE_MS = Number(process.env.AI_SCORE_DRAIN_DEADLINE_MS ?? 110000); // 110s internal budget
const SOFT_STOP_MARGIN_MS = 8000; // Stop starting new work when <8s remaining
```

**Change**: 
- Old: `DEADLINE_MS = 8000ms` (8 seconds)
- New: `DEADLINE_MS = 110000ms` (110 seconds)
- Added graceful soft-stop margin to prevent hard deadline crashes

**Rationale**: 
- Platform timeout was forcing `expired:true` at ~19.6s
- Internal 110s budget allows concurrent scoring to run longer
- Soft margin ensures we stop starting new work when approaching hard limit

---

### 2. Vercel Runtime Allowance

**File**: `app/api/ai/score/drain/route.ts` (Line 11)

```typescript
export const maxDuration = 120; // Allow up to 120s runtime on Vercel/Next.js
```

**Change**: Added `maxDuration = 120` export (previously missing)

**Rationale**: 
- Tells Next.js/Vercel platform to allow this route to run up to 120 seconds
- Supports longer processing without platform-level timeout
- Runtime remains `nodejs` (not edge-constrained)

---

### 3. Concurrent Scoring Pool Implementation

**File**: `app/api/ai/score/drain/route.ts` (Lines 121-257)

New function: `scoreSignalsConcurrent()`

```typescript
async function scoreSignalsConcurrent(
  signals: any[],
  deadlineAtMs: number,
  concurrency: number
): Promise<{
  scoredCount: number;
  errorCount: number;
  timeoutCount: number;
  details: [...];
  results: [...];
}>
```

**Key Features**:
- **Concurrency limit**: Batches signals into groups of 5 (configurable via `SCORING_CONCURRENCY`)
- **Promise.allSettled**: Scores multiple signals in parallel per batch
- **Soft-stop margin check**: Before each batch, verifies remaining time > 8 seconds
- **Three result states**: 
  - `SCORED`: Successfully scored signal
  - `ERROR`: Failed to score (model timeout or other error)
  - `TIMEOUT`: Hit soft-deadline while scoring
- **Details capped**: Max 20 entries returned to keep response size reasonable

**Processing Flow**:
```
while (i < signals.length) {
  if (remainingMs < SOFT_STOP_MARGIN_MS) break;  // Graceful stop
  
  batch = signals.slice(i, i + concurrency);      // Take next 5
  promises = batch.map(signal => scoreWithTimeout(signal, deadline));
  results = await Promise.allSettled(promises);   // Run in parallel
  
  process each result → update signal status
  i += batch.length;
}
```

---

### 4. Improved Response Structure

**File**: `app/api/ai/score/drain/route.ts` (Lines 310-346)

**New Response Fields**:

| Field | Type | Purpose |
|-------|------|---------|
| `attemptedCount` | number | Total signals picked for processing |
| `completedCount` | number | Signals that finished (SCORED or ERROR), excluding TIMEOUT |
| `scoredCount` | number | Successful scores (distinct from `scored`) |
| `errorCount` | number | Failed scores (distinct from `errored`) |
| `timeoutCount` | number | Signals that hit soft deadline |
| `remainingTimeMs` | number | Time remaining in deadline window at response time |

**Legacy Fields** (preserved):
- `processed`: Alias for `scoredCount + errorCount` (for backward compatibility)
- `scored`: Updated to match `scoredCount`
- `errored`: Updated to match `errorCount`
- `expired`: Set to `true` if `timeoutCount > 0` or time margin breached
- `pickedStrategy`: `recent_first` or `backlog_oldest_first`
- `details`: Array of processed signals (capped to 20)

**Example Response**:
```json
{
  "ok": true,
  "processed": 8,
  "scored": 6,
  "errored": 2,
  "skipped": false,
  "expired": false,
  "durationMs": 45230,
  "remainingTimeMs": 64770,
  "releasedCount": 0,
  "reclaimedCount": 0,
  "attemptedCount": 8,
  "completedCount": 8,
  "scoredCount": 6,
  "errorCount": 2,
  "timeoutCount": 0,
  "pickedStrategy": "recent_first",
  "recentWindowHours": 6,
  "details": [
    { "id": "sig-1", "ticker": "AAPL", "status": "SCORED", "aiScore": 8.3 },
    { "id": "sig-2", "ticker": "MSFT", "status": "SCORED", "aiScore": 7.9 },
    ...
  ]
}
```

---

### 5. Preserved Behavior

**Pick Strategy**:
- `backlog=0` (default) → `recent_first` (newest within 6-hour window)
- `backlog=1` → `backlog_oldest_first` (oldest first, no window filter)

**Release Behavior**:
- `releaseLimit=0` → Release none (intraday scoring)
- `releaseLimit=N` → Release up to N unfinalized claims
- `releaseLimit=-1` → Release all unfinalized claims

**Signal State Machine**:
```
PENDING → SCORING (on claim) → SCORED or ERROR (on finalize)
                          ↓
                       PENDING (if timeout or unfinalized)
```

**Stale Signal Reclamation**:
- Signals stuck in `SCORING` for > 10 minutes are reverted to `PENDING`
- Allows recovery from crashed workers

---

## Integration with Intraday Score Worker

**Workflow**: `.github/workflows/intraday-score-worker.yml`

Configuration:
```yaml
schedule: "*/5 13-21 * * 1-5"  # Every 5 minutes, weekdays, UTC 13-21 (9:30 AM-4:00 PM ET)
matrix:
  worker: [1, 2, 3]             # 3 parallel workers
```

**Per Worker**:
```
POST /api/ai/score/drain?limit=15&releaseLimit=0
- limit=15: Pick up to 15 signals
- releaseLimit=0: Release no unfinalized claims (intraday emphasis)
```

**Throughput Estimate**:

| Component | Value | Notes |
|-----------|-------|-------|
| Workers | 3 | Parallel workers |
| Frequency | Every 5 min | 12 runs/hour |
| Signals/run | 8-12 avg | Depends on pending queue |
| Concurrency | 5 per signal | Internal scoring parallelism |
| Scored/run | 8-15 | With concurrent processing |
| Runs/day | 84 | 7 hours market × 12 runs/hour |
| Daily total | 672-1,260 | Conservative: 250–400 expected (accounting for lock contention, errors) |

---

## Testing & Validation

### Build Status
✅ `npm run build` succeeds without errors

### Code Quality
✅ No TypeScript errors  
✅ No ESLint violations  
✅ Backward compatible (legacy fields preserved)

### Runtime Checks
✅ `maxDuration` set correctly for Vercel  
✅ `runtime = "nodejs"` (not edge-constrained)  
✅ Lock acquisition/release intact  
✅ Redis operations preserved  

### Expected Behavior

**Test Case 1**: Intraday market hours run
```
POST /api/ai/score/drain?limit=15&releaseLimit=0
Expected:
  - durationMs > 20000ms (not cut off at ~19600ms)
  - processed >= 8 (when pending exists)
  - expired: false (unless soft margin hit)
  - pickedStrategy: "recent_first"
```

**Test Case 2**: Backlog drain after hours
```
POST /api/ai/score/drain?limit=50&backlog=1&releaseLimit=10
Expected:
  - pickedStrategy: "backlog_oldest_first"
  - releasedCount <= 10
  - processes oldest signals first
```

**Test Case 3**: Concurrent scoring performance
```
With 5 pending signals, concurrency=5:
  - All 5 score in parallel in single batch
  - durationMs: 3-8 seconds (typical GPT latency)
  - scoredCount: 4-5 (one may fail)
```

---

## Environment Variables

Optional configuration (defaults shown):

```bash
# Drain-specific timeouts
AI_SCORE_DRAIN_DEADLINE_MS=110000       # Internal budget (ms)
AI_SCORE_DRAIN_MAX=25                   # Max signals per run
AI_SCORE_DRAIN_CONCURRENCY=5            # Parallel scoring workers
AI_SCORE_DRAIN_RECENT_HOURS=6           # Recent window for pick strategy

# Standard cron auth
CRON_TOKEN=<your-token>
PROD_BASE_URL=https://...
```

---

## Metrics & Monitoring

Key metrics to track:

1. **Throughput**: `gptScored` counter in funnelRedis (updated per drain)
2. **Success Rate**: `processed > 0 && scoredCount / attemptedCount`
3. **Timeout Rate**: `timeoutCount / attemptedCount` (should be rare after changes)
4. **Duration Distribution**: `durationMs` histogram (should see wider distribution now)
5. **Lock Contention**: Watch logs for "already_running" (indicates queue building)

---

## References

- **Original Route**: `app/api/ai/score/drain/route.ts`
- **Worker Workflow**: `.github/workflows/intraday-score-worker.yml`
- **Backlog Worker**: `.github/workflows/backlog-worker.yml` (unchanged)

---

## Rollback Plan

If issues arise:

1. **Revert to 8s timeout**: 
   ```bash
   export AI_SCORE_DRAIN_DEADLINE_MS=8000
   ```

2. **Disable concurrency** (fall back to sequential):
   ```bash
   export AI_SCORE_DRAIN_CONCURRENCY=1
   ```

3. **Reduce max per run**:
   ```bash
   export AI_SCORE_DRAIN_MAX=10
   ```

No database migrations or breaking changes—purely configuration.

---

## Summary

✅ **COMPLETE IMPLEMENTATION**

- [x] Increased DEADLINE_MS to 110s
- [x] Added `maxDuration = 120` export
- [x] Implemented concurrent scoring pool (batches of 5)
- [x] Enhanced response with 6 new detailed fields
- [x] Preserved all existing behavior (strategy, releaseLimit, signals state)
- [x] Build verified without errors
- [x] Ready for production deployment

**Expected Result**: 250–400 GPT scores/day during market hours with parallel intraday-score-worker.yml running 3 workers every 5 minutes.
