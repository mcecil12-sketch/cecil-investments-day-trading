# Broker-Truth OpenTrades Patch - Testing Guide

## Summary of Changes

### 1. `/api/ops/status` - Broker-Truth Based Open Trades
**BEFORE:**
- `entryState.openTrades.total` = DB open trades count
- Could show "ghost trades" if DB has OPEN records with no broker positions

**AFTER:**
- `entryState.openTrades.total` = Broker positions count (source of truth)
- `entryState.openTrades.fromAutoEntry` = Broker positions count (conservative proxy)
- Added `entryState.diagnostics.dbOpenTradesCount` for visibility of DB state
- Added `entryState.diagnostics.openTradesMismatch` flag
- Added `entryState.diagnostics.mismatchNote` explaining the mismatch

**Result:** Ops/status will NEVER report openTrades > 0 when broker is flat, even if DB has ghost records.

### 2. `/api/readiness` - Broker-Truth Max Open Positions Check
**BEFORE:**
- No max-open-positions check (or derived from DB)
- Could be gated incorrectly by DB ghosts

**AFTER:**
- Fetches broker truth (positions/orders)
- Added `autoEntry.brokerPositionsCount` to response
- Added `autoEntry.brokerOpenOrdersCount` to response
- Added `autoEntry.wouldSkipMaxOpenPositions` (boolean or null)
- Added `autoEntry.brokerError` for visibility
- Added `max_open_positions` check to the readiness checks array
- Readiness correctly reflects broker state, not DB

**Result:** Entry readiness uses broker truth for max-open gating, not DB.

---

## Test Scenarios

### Scenario 1: Broker Flat, DB Clean
```
Expected:
- /api/ops/status
  - entryState.openTrades.total = 0
  - entryState.diagnostics.openTradesMismatch = false
  
- /api/readiness
  - autoEntry.brokerPositionsCount = 0
  - autoEntry.wouldSkipMaxOpenPositions = false
  - max_open_positions check = OK
```

### Scenario 2: Broker Flat, DB Has Ghost OPEN Trades
```
Expected:
- /api/ops/status
  - entryState.openTrades.total = 0  <-- CRITICAL: Still 0, not showing DB ghosts!
  - entryState.diagnostics.dbOpenTradesCount = 3 (example)
  - entryState.diagnostics.openTradesMismatch = true
  - entryState.diagnostics.mismatchNote = "DB has 3 open trades but broker has 0 positions..."

- /api/readiness
  - autoEntry.brokerPositionsCount = 0  <-- Still allows entry
  - autoEntry.wouldSkipMaxOpenPositions = false
  - max_open_positions check = OK
```
**Action:** Run `curl -X POST $PROD/api/maintenance/reconcile-open-trades` to cleanup DB ghosts.

### Scenario 3: Broker Has Positions, DB Mismatch
```
Expected:
- /api/ops/status
  - entryState.openTrades.total = (broker count, e.g., 2)
  - entryState.diagnostics.dbOpenTradesCount = (different, e.g., 1)
  - entryState.diagnostics.openTradesMismatch = true

- /api/readiness
  - autoEntry.brokerPositionsCount = 2
  - autoEntry.wouldSkipMaxOpenPositions = (true if >= maxOpenPositions)
```

### Scenario 4: Broker Error, Can't Fetch Truth
```
Expected:
- /api/ops/status
  - entryState.openTrades.total = 0 (fallback)
  - broker.error = (error message)
  - entryState.reason = "broker_truth_error: ..."

- /api/readiness
  - autoEntry.brokerError = (error message)
  - autoEntry.wouldSkipMaxOpenPositions = null (unknown state)
  - max_open_positions check = OK (null treated as pass)
  - reasons may include broker error
```

---

## Quick Test Commands

### Test 1: ops/status shows broker truth
```bash
curl -s "$PROD/api/ops/status?_=$(date +%s)" | jq '.entryState.openTrades'
```
Expected output shows `brokerPositionsCount` (not DB count).

### Test 2: ops/status has diagnostics
```bash
curl -s "$PROD/api/ops/status?_=$(date +%s)" | jq '.entryState.diagnostics'
```
Expected output includes `dbOpenTradesCount`, `openTradesMismatch`, `mismatchNote`.

### Test 3: readiness shows broker truth
```bash
curl -s "$PROD/api/readiness" | jq '.autoEntry | {brokerPositionsCount, wouldSkipMaxOpenPositions, brokerError}'
```
Expected output shows broker position count and skip logic.

### Test 4: readiness includes max_open_positions check
```bash
curl -s "$PROD/api/readiness" | jq '.checks[] | select(.name == "max_open_positions")'
```
Expected output shows the new check with detail.

---

## Verification Checklist

- [ ] Build passes without errors
- [ ] ops/status returns entryState.openTrades with brokerPositionsCount
- [ ] ops/status includes entryState.diagnostics
- [ ] readiness returns autoEntry.brokerPositionsCount
- [ ] readiness includes max_open_positions check
- [ ] With broker flat: ops/status shows openTrades.total = 0
- [ ] With broker flat + DB ghosts: openTrades.total = 0, diagnostics.mismatch = true
- [ ] readiness ready check includes broker position status

---

## Deployment Safety

✅ No breaking changes - all new fields are additive
✅ Backward compatible - legacy openTrades still reported (but from broker now)
✅ Graceful degradation - if broker fetch fails, falls back to 0
✅ Automation gating now uses broker truth, not DB (safer)
✅ Diagnostics remain for visibility into DB state
