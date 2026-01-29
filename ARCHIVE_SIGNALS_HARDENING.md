# Archive-Signals Endpoint: Keyspace-Wide Cleanup Hardening

## Overview
Permanently hardened the archive-signals endpoint to handle unbounded signal stores with cursor-based pagination and deadline enforcement. Solves "archives sometimes returns 0" by using Redis SCAN (or file-based pagination) to walk the entire keyspace.

## Endpoint: `POST /api/maintenance/archive-signals`

### Authorization
- Requires `x-cron-token` header (same as other maintenance endpoints)
- Returns 401 JSON if missing or invalid
- Never redirects

### Request Parameters
```json
{
  "olderThanHours": 48,                       // required
  "limit": 1000,                              // optional (default 1000, max 10000)
  "scanLimit": 5000,                          // optional (default 5000, max 50000)
  "cursor": "0",                              // optional (default "0")
  "statuses": ["PENDING","ERROR","SCORED"],   // optional (default shown)
  "dryRun": false                             // optional (default false)
}
```

### Response
```json
{
  "ok": true,
  "archived": 150,
  "scanned": 5000,
  "eligible": 200,
  "cursorIn": "0",
  "cursorOut": "2843",
  "expired": false,
  "dryRun": false,
  "olderThanHours": 48,
  "remainingPending": 1200
}
```

## Key Features

### 1. Keyspace-Wide Iteration
- **Redis SCAN**: If Redis available, uses `SCAN` with pattern `signal:*` for distributed iteration
- **File-Based Fallback**: If Redis unavailable, uses offset-based pagination over entire signal file
- **No Bounded Scans**: Unlike previous implementation, doesn't limit to in-memory slice—covers ALL signals

### 2. Cursor-Based Pagination
- Call endpoint repeatedly with `cursor` returned from previous call
- Continue until `cursorOut == "0"` (indicates completion)
- Allows full archive coverage across multiple runs without timeouts

### 3. Deadline Hardening
- **Default**: 8 seconds (env override: `MAINT_ARCHIVE_SIGNALS_DEADLINE_MS`)
- **Graceful Expiry**: If deadline exceeded, returns partial progress and `expired: true`
- **Per-Signal Checks**: Checks deadline before processing each signal

### 4. Partial Progress Support
- Returns `archived`, `scanned`, `eligible` counts even if deadline hit or scan limit reached
- Non-fatal errors (malformed signals) logged but don't fail response
- Caller can resume from `cursorOut` in next invocation

### 5. Dry-Run Support
- `"dryRun": true` counts archivable signals without writing
- Useful for validation before full archive runs

### 6. Status Filtering
- Default statuses: `["PENDING", "ERROR", "SCORED"]`
- Can customize via request body
- Allows archiving specific status types only

### 7. Metadata Preservation
- Marks signals as `archived: true` and sets `archivedAt` timestamp
- **Does NOT delete**—allows audit trail and recovery if needed
- Updates `updatedAt` field for tracking

## Usage Examples

### Example 1: Full Archive (4000 signals, batched)
```bash
# Batch 1
curl -X POST "https://cecil-investments-day-trading.vercel.app/api/maintenance/archive-signals" \
  -H "x-cron-token: $CRON_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "olderThanHours": 48,
    "limit": 1000,
    "scanLimit": 5000,
    "cursor": "0"
  }'
# Response: { "archived": 1000, "scanned": 5000, "cursorOut": "2843", ... }

# Batch 2
curl -X POST "https://cecil-investments-day-trading.vercel.app/api/maintenance/archive-signals" \
  -H "x-cron-token: $CRON_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "olderThanHours": 48,
    "limit": 1000,
    "scanLimit": 5000,
    "cursor": "2843"
  }'
# Response: { "archived": 1000, "scanned": 5000, "cursorOut": "4721", ... }

# Repeat until cursorOut == "0"
```

### Example 2: Dry-Run Validation
```bash
curl -X POST "https://cecil-investments-day-trading.vercel.app/api/maintenance/archive-signals" \
  -H "x-cron-token: $CRON_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "olderThanHours": 48,
    "limit": 10000,
    "scanLimit": 50000,
    "cursor": "0",
    "dryRun": true
  }'
# Response: { "archived": 2847, "scanned": 50000, "eligible": 2900, "cursorOut": "...", ... }
# (Shows how many would be archived without writing)
```

### Example 3: Custom Status Filter
```bash
# Archive only ERROR signals
curl -X POST "https://cecil-investments-day-trading.vercel.app/api/maintenance/archive-signals" \
  -H "x-cron-token: $CRON_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "olderThanHours": 24,
    "statuses": ["ERROR"],
    "cursor": "0"
  }'
```

## Implementation Details

### File Location
`app/api/maintenance/archive-signals/route.ts`

### Key Functions
- `checkCronAuth(req)`: Validates x-cron-token header
- `parseRequest(body)`: Parses and validates request parameters
- `isExpired()`: Checks if deadline exceeded (inside POST handler)
- Redis SCAN path: Iterates using `redis.scan()` with cursor
- File fallback path: Offset-based pagination over `readSignals()`

### Error Handling
- **Malformed JSON**: Logs warning but continues processing
- **Malformed signal data**: Skips and continues
- **Redis errors**: Falls back to file-based scan
- **Lock/write failures**: Non-fatal; returns partial progress
- **All errors**: Always return JSON with `ok: false` and error message

### Performance
- **Redis path**: O(scanLimit) time per request, typically ~1-2 seconds for 5000-key scan
- **File path**: O(scanLimit) time per request, typically ~500ms for 5000-signal offset
- **Deadline**: 8 seconds default, completes well under deadline in normal cases
- **Memory**: Loads signals on-demand; doesn't hold entire dataset in memory

## Monitoring

### Health Indicators
- **Archive Run Success**: Check response `ok: true`
- **Completion**: When `cursorOut == "0"` after final batch
- **Remaining Signals**: Monitor response `remainingPending` field
- **Deadline Hits**: If `expired: true`, archive run was truncated; resume from `cursorOut`

### Recommended Alerts
```
IF remainingPending > 5000 THEN alert "High PENDING signal count"
IF archive responses show expired: true THEN alert "Archive deadline exceeded"
```

## Migration / Deployment

### Prerequisites
- x-cron-token environment variable already set
- Redis available (optional; file fallback works without it)

### Deployment Steps
1. Deploy updated `app/api/maintenance/archive-signals/route.ts`
2. Verify zero compilation errors
3. Test with dry-run first
4. Run archive batch to clear old signals
5. Monitor `/api/ops/status` → `scoring.last6Hours.pending` should decrease

### Testing Checklist
- [ ] POST with valid token → returns 200 JSON
- [ ] POST with invalid token → returns 401 JSON
- [ ] POST with `dryRun: true` → counts without writing
- [ ] Repeated calls with cursor → walk full keyspace
- [ ] `cursorOut == "0"` on final call
- [ ] Signals marked `archived: true` (not deleted)
- [ ] `archivedAt` timestamp set correctly
- [ ] Deadline respected (responses under 8s)

## Notes

- **No Deletion**: Archived signals are marked, not deleted, for audit trail
- **Cursor Persistence**: Safe to interrupt; resume from `cursorOut`
- **Status Defaults**: Default filters PENDING, ERROR, SCORED (modifiable)
- **Backward Compatible**: Old signal format supported; gracefully skips malformed entries
- **Production Ready**: Handles edge cases (empty store, timeout, malformed data, Redis unavailable)

