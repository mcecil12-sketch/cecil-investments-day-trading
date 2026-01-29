# Operational Guide: "No Activity" Hardening

## Quick Diagnosis

When "no activity" occurs (no orders despite pending signals):

### Step 1: Check System Status
```bash
curl -s https://cecil-investments-day-trading.vercel.app/api/ops/status | jq .
```

### Step 2: Interpret Results

**Check these fields in order:**

1. **`broker.error`** (top priority)
   - If not null: Broker connection failed
   - Action: Verify ALPACA_* env vars, wait for recovery

2. **`entryState.wouldSkipMaxOpenPositions`**
   - If true: Entry is gated by position limit
   - Action: Close positions or increase `AUTO_ENTRY_MAX_OPEN_POSITIONS`
   - Detail shows: `brokerPositionsCount=X, maxOpenPositions=Y`

3. **`entryState.guardState.autoDisabledReason`**
   - If not null: Auto-entry circuit breaker tripped
   - Reasons: too many consecutive failures, cooldown after loss, etc.
   - Action: Review telemetry, fix underlying issue

4. **`scoring.last6Hours.backlog`**
   - Should be 0 or very small
   - If > 10: Drain job may not be running
   - Action: Check score-drain workflow status

5. **`health.entryReadiness`**
   - If false: Some blocker exists
   - Check all above fields to identify it

---

## Common Issues & Fixes

### Issue: pending=200, scored=0
**Cause:** Scoring never ran or drain job not active

**Fix:**
1. Check if score-drain workflow exists and is enabled
2. Manually trigger: `POST /api/ai/score/drain?limit=50` with `x-cron-token`
3. Verify `gptScored` counter increments in funnel

### Issue: wouldSkipMaxOpenPositions=true
**Cause:** Broker shows 3+ open positions, max is 3

**Fix:**
1. Check `/api/ops/status` → `broker.positions` list
2. Close positions in Alpaca dashboard that shouldn't exist
3. Run reconcile: `POST /api/maintenance/reconcile-open-trades` with `x-cron-token`
4. Wait for next auto-entry run to try again

### Issue: lastAutoEntry.reason = "broker_truth_unavailable"
**Cause:** Broker connection failed during entry gating

**Fix:**
1. Check Alpaca API status (status.alpaca.markets)
2. Verify `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` env vars
3. Test connectivity: `GET https://api.alpaca.markets/v2/clock`
4. Restart deployment or wait for automatic recovery

### Issue: lastAutoEntry.reason = "circuit_breaker"
**Cause:** Too many failures or loss cooldown active

**Fix:**
1. Check `entryState.guardState.lastLossAt`
2. If recent: Wait for cooldown to expire (default 20 minutes)
3. If old: Check consecutive failures - may need to fix underlying issues

---

## Manual Operations

### Trigger a Drain Run (immediate scoring)
```bash
curl -X POST "https://cecil-investments-day-trading.vercel.app/api/ai/score/drain?limit=50" \
  -H "x-cron-token: $CRON_TOKEN" \
  -H "Content-Type: application/json"
```

### Run Reconciliation (clean up stale trades)
```bash
curl -X POST "https://cecil-investments-day-trading.vercel.app/api/maintenance/reconcile-open-trades" \
  -H "x-cron-token: $CRON_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false, "max": 100}'
```

### Dry-Run Reconciliation (see what would change)
```bash
curl -X POST "https://cecil-investments-day-trading.vercel.app/api/maintenance/reconcile-open-trades" \
  -H "x-cron-token: $CRON_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true, "max": 100}' | jq .
```

### Check Last 20 Scoring Drain Runs
```bash
curl -s "https://cecil-investments-day-trading.vercel.app/api/ai/score?limit=20" | jq '.signals | map(select(.status == "ERROR" or .status == "SCORED"))'
```

---

## Monitoring & Alerts

### Key Metrics to Watch

**Critical (alert if any):**
- `/api/ops/status` → `broker.error` is not null
- `/api/ops/status` → `health.entryReadiness` is false

**Warning (alert if persistent):**
- `/api/ops/status` → `scoring.last6Hours.backlog` > 10
- `/api/ops/status` → `entryState.guardState.autoDisabledReason` not null for >30 min
- `/api/ops/status` → `entryState.wouldSkipMaxOpenPositions` true (verify positions list)

**Info (track for debugging):**
- `scoring.last6Hours.pending` count over time
- `broker.positionsCount` vs `entryGating.maxOpenPositions`
- `lastAutoEntry.reason` frequency

### Recommended Alert Setup

```bash
# Alert if entry readiness is false
if [ "$(curl -s https://cecil-investments-day-trading.vercel.app/api/ops/status | jq .health.entryReadiness)" = "false" ]; then
  # Send alert to Slack/Email
fi

# Alert if scoring backlog >10
BACKLOG=$(curl -s https://cecil-investments-day-trading.vercel.app/api/ops/status | jq '.scoring.last6Hours.backlog')
if [ "$BACKLOG" -gt 10 ]; then
  # Send alert to Slack/Email
fi
```

---

## Understanding the Flow

### Normal Operation (entry succeeds)
```
1. Auto-entry cron triggers every 5 minutes
2. Fetches broker-truth (real positions from Alpaca)
3. Checks: brokerPositionsCount < maxOpenPositions?
4. If yes: Looks for PENDING trades to execute
5. Executes entry orders
6. Logs telemetry with "SUCCESS"
```

### Blocked Entry (and why)
```
Scenario: No orders placed

Possible reasons (checked in order):
1. broker.error ≠ null         → Alpaca connection failed
2. wouldSkipMaxOpenPositions  → Broker shows >= max positions
3. autoDisabledReason         → Circuit breaker tripped
4. cooldownRemainingMin       → Loss cooldown active
5. no PENDING trades found    → No trades to execute
```

### Scoring Pipeline (drain job)
```
1. Drain cron triggers every 5 minutes
2. Acquires lock (prevents parallel runs)
3. Finds PENDING signals (last 24 hours, recent first)
4. For each signal (up to limit=25):
   - Calls AI scoring
   - Marks as SCORED or ERROR
5. Updates funnel counters
6. Releases lock
7. Returns detailed results
```

---

## Advanced: Checking Internal State

### View All PENDING Signals
```bash
curl -s "https://cecil-investments-day-trading.vercel.app/api/signals/all?status=PENDING&limit=100" | jq '.signals'
```

### View Auto-Entry Telemetry (today)
```bash
curl -s "https://cecil-investments-day-trading.vercel.app/api/auto-entry/telemetry" | jq '.summary'
```

### View Scoring Funnel (today)
```bash
curl -s "https://cecil-investments-day-trading.vercel.app/api/signals/funnel" | jq '.'
```

---

## Key Configuration

**Auto-Entry Limits** (environment variables):
- `AUTO_ENTRY_MAX_OPEN_POSITIONS=3` - Won't enter if broker has ≥ 3 positions
- `AUTO_ENTRY_MAX_ENTRIES_PER_DAY=5` - Max entries allowed per day
- `AUTO_ENTRY_COOLDOWN_AFTER_LOSS_MIN=20` - Cooldown after losing trade
- `AUTO_ENTRY_MAX_CONSECUTIVE_FAILURES=3` - Disable after this many fails

**AI Scoring** (environment variables):
- `AI_MIN_SCORE_TO_QUALIFY=7.0` - Score needed to show in app
- `AI_MIN_GRADE_TO_QUALIFY=B` - Grade needed to show in app
- `CRON_TOKEN` - Required for drain and reconcile endpoints

---

## Troubleshooting Checklist

- [ ] Market open? (check `market.isOpen` in status)
- [ ] Broker connected? (check `broker.error` is null)
- [ ] Positions within limit? (compare `broker.positionsCount` vs `maxOpenPositions`)
- [ ] Auto-entry enabled? (check `entryGating.enabled`)
- [ ] No circuit breaker? (check `guardState.autoDisabledReason` is null)
- [ ] Scoring running? (check `scoring.last6Hours.backlog` is low)
- [ ] Recent auto-entry run? (check `lastAutoEntry.at` is recent)
- [ ] Last run reason sensible? (check `lastAutoEntry.reason`)

If all pass: System should be attempting entry on suitable signals.
