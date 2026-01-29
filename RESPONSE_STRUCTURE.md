# API Response Structure: Before & After

## Endpoint: `/api/ops/status`

### BEFORE (DB-based open trades)
```json
{
  "entryState": {
    "wouldSkipMaxOpenPositions": false,
    "reason": "READY",
    "guardState": { ... },
    "openTrades": {
      "total": 3,           // ⚠️  From DB (could be ghosts!)
      "fromAutoEntry": 2
    }
    // ❌ No diagnostics for DB state
  },
  "broker": {
    "positionsCount": 0,   // Broker is flat
    "openOrdersCount": 0,
    "positions": [],
    "openOrders": []
  }
}
```

### AFTER (Broker-truth based)
```json
{
  "entryState": {
    "wouldSkipMaxOpenPositions": false,
    "reason": "READY",
    "guardState": { ... },
    "openTrades": {
      "total": 0,                    // ✅ From broker truth (0 positions)
      "fromAutoEntry": 0,            // ✅ Broker proxy
      "brokerPositionsCount": 0,     // ✅ EXPLICIT: Broker positions
      "brokerOpenOrdersCount": 0     // ✅ EXPLICIT: Broker orders
    },
    // ✅ NEW: Diagnostics for observability
    "diagnostics": {
      "dbOpenTradesCount": 3,        // DB has 3 OPEN records
      "dbAutoOpenTradesCount": 2,    // DB has 2 auto-entry OPEN
      "openTradesMismatch": true,    // DB ≠ Broker!
      "mismatchNote": "DB has 3 open trades but broker has 0 positions. Run reconcile-open-trades to cleanup."
    }
  },
  "broker": {
    "positionsCount": 0,
    "openOrdersCount": 0,
    "positions": [],
    "openOrders": []
  }
}
```

---

## Endpoint: `/api/readiness`

### BEFORE (No explicit max-open check)
```json
{
  "ready": true,
  "autoEntry": {
    "enabled": true,
    "envEnabled": true,
    "maxOpenPositions": 5,
    "consecutiveFailures": 0,
    "maxConsecutiveFailures": 3,
    "entriesToday": 1,
    "maxEntriesPerDay": 10,
    // ❌ No broker position info
    // ❌ No explicit max-open check
  },
  "checks": [
    { "name": "market_open", "ok": true, "detail": "..." },
    { "name": "ai_healthy", "ok": true, "detail": "..." },
    { "name": "scanner_running", "ok": true, "detail": "..." },
    { "name": "scanner_recent", "ok": true, "detail": "..." },
    { "name": "scoring_flowing", "ok": true, "detail": "..." }
    // ❌ No max_open_positions check
  ]
}
```

### AFTER (Broker-truth max-open check)
```json
{
  "ready": true,
  "autoEntry": {
    "enabled": true,
    "envEnabled": true,
    "maxOpenPositions": 5,
    "consecutiveFailures": 0,
    "maxConsecutiveFailures": 3,
    "entriesToday": 1,
    "maxEntriesPerDay": 10,
    // ✅ NEW: Broker position info
    "brokerPositionsCount": 0,       // From broker truth
    "brokerOpenOrdersCount": 0,      // From broker truth
    "wouldSkipMaxOpenPositions": false,  // ✅ Derived from broker
    "brokerError": null              // Broker fetch status
  },
  "checks": [
    { "name": "market_open", "ok": true, "detail": "..." },
    { "name": "ai_healthy", "ok": true, "detail": "..." },
    { "name": "scanner_running", "ok": true, "detail": "..." },
    { "name": "scanner_recent", "ok": true, "detail": "..." },
    { "name": "scoring_flowing", "ok": true, "detail": "..." },
    // ✅ NEW: Max-open-positions check using broker truth
    {
      "name": "max_open_positions",
      "ok": true,
      "detail": "broker positions: 0 / max: 5"
    }
  ]
}
```

---

## Key Differences

| Aspect | Before | After |
|--------|--------|-------|
| **openTrades.total** | DB count | Broker count ✅ |
| **openTrades.fromAutoEntry** | DB count | Broker count ✅ |
| **Diagnostics** | None | Full DB/broker comparison ✅ |
| **Max-open check** | Implicit / Missing | Explicit check ✅ |
| **Broker positions visible** | In broker section | Also in autoEntry ✅ |
| **Ghost detection** | No | Yes (diagnostics.mismatch) ✅ |
| **Entry gating inputs** | DB-based | Broker-based ✅ |

---

## Scenario: Broker Flat + DB Has Ghosts

### ops/status Response (Relevant Section)
```json
{
  "entryState": {
    "openTrades": {
      "total": 0,                    // Shows 0 (NOT 3!)
      "fromAutoEntry": 0,            // Shows 0 (NOT 2!)
      "brokerPositionsCount": 0,     // Truth: 0 positions
      "brokerOpenOrdersCount": 0
    },
    "diagnostics": {
      "dbOpenTradesCount": 3,        // Visible: DB has 3
      "dbAutoOpenTradesCount": 2,    // Visible: 2 are auto-entry
      "openTradesMismatch": true,    // FLAG: Mismatch detected
      "mismatchNote": "DB has 3 open trades but broker has 0 positions. Run reconcile-open-trades to cleanup."
    }
  },
  "broker": {
    "positionsCount": 0,             // Confirms: broker is flat
    "openOrdersCount": 0
  }
}
```

### readiness Response (Relevant Section)
```json
{
  "ready": true,
  "autoEntry": {
    "maxOpenPositions": 5,
    "brokerPositionsCount": 0,       // Truth: 0 positions
    "wouldSkipMaxOpenPositions": false  // Entry NOT blocked by DB ghosts
  },
  "checks": [
    ...,
    {
      "name": "max_open_positions",
      "ok": true,                     // Check passes despite DB ghosts
      "detail": "broker positions: 0 / max: 5"
    }
  ]
}
```

**Result**: 
✅ Ops shows the truth (0 positions) with diagnostics
✅ Readiness allows entry (not blocked by DB)
✅ Automation can proceed without being misled by DB ghosts
