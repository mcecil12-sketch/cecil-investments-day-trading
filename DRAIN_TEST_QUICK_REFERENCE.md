# AI Drain Quick Test Reference

## What Changed

The drain endpoint (`/api/ai/score/drain`) was completely refactored to:
1. **Always pick newest signals first** (not oldest backlog)
2. **Never mark signals ERROR due to deadline** (run expires, signals stay PENDING)
3. **Claim signals as SCORING** before scoring (prevent concurrent processing)
4. **Return visibility fields** showing strategy, window, age range

---

## Test Command

```bash
# Set variables
PROD="https://cecil-investments-day-trading.vercel.app"
CRON_TOKEN="your-cron-token-here"

# Run drain and check response
curl -s -X POST "$PROD/api/ai/score/drain?_=$(date +%s)" \
  -H "x-cron-token: $CRON_TOKEN" \
  -H "Content-Type: application/json" | jq '.'
```

---

## Expected Response Structure

```json
{
  "ok": true,
  "processed": 3,
  "scored": 2,
  "errored": 0,
  "skipped": false,
  "expired": false,
  "durationMs": 1523,
  
  "pickedStrategy": "recent_first",
  "recentWindowHours": 6,
  "newestPickedCreatedAt": "2026-01-29T11:45:30.123Z",
  "oldestPickedCreatedAt": "2026-01-29T08:20:15.456Z",
  
  "details": [
    {
      "id": "sig-abc123",
      "ticker": "AAPL",
      "status": "SCORED",
      "aiScore": 8.5
    },
    {
      "id": "sig-def456",
      "ticker": "MSFT",
      "status": "SCORED",
      "aiScore": 7.2
    }
  ]
}
```

---

## Key Fields Explained

### pickedStrategy
- `"recent_first"` → Found signals in recent window (last 6h)
- `"backlog_fallback"` → Recent window empty, using older backlog

### recentWindowHours
- Number of hours considered "recent" (default: 6)
- Override with env: `AI_SCORE_DRAIN_RECENT_HOURS=2`

### newestPickedCreatedAt / oldestPickedCreatedAt
- **Newest**: Most recent signal that was picked (e.g., 11:45)
- **Oldest**: Oldest signal that was picked (e.g., 08:20)
- **Span**: Drain scored signals created between these timestamps

### processed vs scored vs errored
- `processed`: Signals attempted
- `scored`: Successfully scored (status=SCORED, aiScore set)
- `errored`: Failed (status=ERROR, error=model_timeout or other)
- **Sum rule**: processed = scored + errored (if not expired)

### expired
- `true`: Wall-clock deadline hit, remaining signals left PENDING
- `false`: Completed normally or had single-signal timeouts

---

## Test Scenarios

### Scenario 1: Recent Window Has Signals
```bash
# Create 5 signals within last 6 hours
# Expected:
# - pickedStrategy: "recent_first"
# - newestPickedCreatedAt: recent (< 6h old)
# - processed: 5 (or up to MAX_PER_RUN limit)
```

### Scenario 2: Recent Window Empty, Older Backlog Exists
```bash
# Create signals all > 6 hours old
# Expected:
# - pickedStrategy: "backlog_fallback"
# - processed: >0 (picking from older backlog)
```

### Scenario 3: Deadline Expires Mid-Run
```bash
# Set tight deadline: AI_SCORE_DRAIN_DEADLINE_MS=2000
# Expected:
# - expired: true
# - processed: fewer than MAX_PER_RUN
# - scored: partial (some completed before deadline)
# - NO signals marked ERROR: "deadline_exceeded"
# - Unprocessed signals still PENDING
```

### Scenario 4: Single Signal Timeout (Model Takes Too Long)
```bash
# Score a signal that times out
# Expected:
# - 1 detail with status: "ERROR", error: "model_timeout"
# - drain continues processing next signal
# - durationMs includes the timeout wait
```

---

## Verification Checklist

- [ ] Build passes: `npm run build`
- [ ] Drain response includes `pickedStrategy` field
- [ ] Recent signals are picked before old signals
- [ ] If expired, no signals marked ERROR: "deadline_exceeded"
- [ ] If model times out, signal marked ERROR: "model_timeout"
- [ ] newestPickedCreatedAt is more recent than oldestPickedCreatedAt
- [ ] Signals are visible in SCORING status during drain (briefly)
- [ ] Unprocessed SCORING signals revert to PENDING on deadline expire
- [ ] Funnel counters update (gptScored) after successful run

---

## Environment Variables

```bash
# Recent window (hours)
AI_SCORE_DRAIN_RECENT_HOURS=6

# Run deadline (ms)
AI_SCORE_DRAIN_DEADLINE_MS=8000

# Max signals per run
AI_SCORE_DRAIN_MAX=25

# Cron token (existing)
CRON_TOKEN=your-secret
```

---

## Logs to Watch

```bash
# Look for these log messages:
# [score/drain] start { pickedStrategy, pickedCount, recentWindowHours, ... }
# [score/drain] deadline expired { processed, scored, errored, ... }
# [score/drain] complete { processed, scored, errored, expired, ... }
```

---

## Common Issues & Fixes

### Issue: All signals showing as ERROR
- **Cause**: Model API is down or timing out
- **Check**: Look for `error: "model_timeout"` in details
- **Fix**: Check API health, increase deadline if model is slow

### Issue: Drain is picking old signals, not new ones
- **Cause**: Recent window empty, fallback triggered
- **Check**: Verify `pickedStrategy: "backlog_fallback"`
- **Action**: Create new signals or wait for new signals to arrive

### Issue: Signals stuck in SCORING status
- **Cause**: Drain crashed mid-run, lock TTL not released
- **Fix**: Wait 2 minutes (TTL) or manually reset status to PENDING

### Issue: Drain returning expired=true with few processed
- **Cause**: Deadline too tight or model very slow
- **Fix**: Increase `AI_SCORE_DRAIN_DEADLINE_MS` (default 8000ms)
