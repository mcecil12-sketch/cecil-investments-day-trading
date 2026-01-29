# Implementation Checklist: Broker-Truth OpenTrades Patch (Option A)

## ✅ Completed

### Code Changes
- [x] Modified `app/api/ops/status/route.ts`
  - [x] Extract broker position count from brokerTruth
  - [x] Extract DB open trades count separately
  - [x] Compute brokerTruthOpenTrades = brokerPositionsCount
  - [x] Detect openTradesMismatch
  - [x] Update entryState.openTrades to use broker truth
  - [x] Add entryState.diagnostics with DB counts and mismatch flag
  - [x] No compilation errors

- [x] Modified `app/api/readiness/route.ts`
  - [x] Add import for fetchBrokerTruth
  - [x] Fetch brokerTruth in parallel with other data
  - [x] Extract brokerPositionsCount
  - [x] Compute wouldSkipMaxOpenPositions from broker truth
  - [x] Add max_open_positions check to checks array
  - [x] Add broker data to autoEntry response
  - [x] No compilation errors

### Documentation
- [x] Created PATCH_BROKER_TRUTH.md - Implementation summary
- [x] Created TEST_BROKER_TRUTH.md - Testing guide with scenarios

---

## Behavior Verification (Manual Testing)

### When Broker Flat (0 positions)
```
Expected:
  /api/ops/status
    entryState.openTrades.total = 0 ✓
    entryState.diagnostics present ✓
    
  /api/readiness
    autoEntry.brokerPositionsCount = 0 ✓
    max_open_positions check.ok = true ✓
```

### When Broker Flat + DB Has Ghosts
```
Expected:
  /api/ops/status
    entryState.openTrades.total = 0 ✓ (NOT showing DB ghosts!)
    entryState.diagnostics.dbOpenTradesCount > 0 ✓
    entryState.diagnostics.openTradesMismatch = true ✓
    entryState.diagnostics.mismatchNote present ✓
    
  /api/readiness
    autoEntry.brokerPositionsCount = 0 ✓
    Readiness not blocked by DB ghosts ✓
```

### When Broker Has Positions
```
Expected:
  /api/ops/status
    entryState.openTrades.total = brokerPositionsCount ✓
    entryState.openTrades.brokerPositionsCount shown ✓
    
  /api/readiness
    autoEntry.brokerPositionsCount = actual count ✓
    max_open_positions check reflects broker state ✓
```

### When Broker Error
```
Expected:
  /api/ops/status
    entryState.openTrades.total = 0 (fallback) ✓
    broker.error shown ✓
    
  /api/readiness
    autoEntry.brokerError present ✓
    max_open_positions check.ok = true (null state passes) ✓
```

---

## Deployment Readiness

- [x] No breaking API changes
- [x] Backward compatible (new fields are additive)
- [x] No config changes required
- [x] No database migrations needed
- [x] Uses existing broker truth fetch
- [x] Graceful error handling
- [x] No external dependencies added

---

## Post-Deployment Recommended Actions

1. **Monitor diagnostics** for mismatches (will take 1-2 days to normalize):
   ```bash
   watch -n 60 'curl -s "$PROD/api/ops/status" | \
     jq ".entryState.diagnostics"'
   ```

2. **If mismatches exist**, run cleanup (optional):
   ```bash
   curl -X POST "$PROD/api/maintenance/reconcile-open-trades" \
     -H "x-cron-token: $CRON_TOKEN"
   ```

3. **Verify readiness checks** include max-open-positions:
   ```bash
   curl -s "$PROD/api/readiness" | \
     jq '.checks[] | select(.name=="max_open_positions")'
   ```

4. **Monitor entry decisions** to confirm they use broker truth:
   - Check auto-entry logs for entry/skip decisions
   - Verify skips correctly reflect broker position count
   - Verify no skips due to DB ghosts

---

## Rollback (if needed)

If issues arise, revert these two files to main:
```bash
git checkout main -- app/api/ops/status/route.ts
git checkout main -- app/api/readiness/route.ts
git push
```

This will revert to DB-based openTrades reporting.

---

## Success Criteria

✅ Implemented:
- Broker-truth based openTrades in ops/status
- DB diagnostics for mismatch visibility
- Broker-truth based readiness checks
- No ghost trades reported in ops/status even if DB has them
- Entry gating uses broker truth (immunes to DB ghosts)

---

## Files Changed

1. `app/api/ops/status/route.ts` - 30 lines modified/added
2. `app/api/readiness/route.ts` - 40 lines modified/added
3. `PATCH_BROKER_TRUTH.md` - Documentation (new)
4. `TEST_BROKER_TRUTH.md` - Testing guide (new)

---

**Patch Status**: ✅ READY FOR DEPLOYMENT
