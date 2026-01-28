# Diff Summary: Auto-Manage Force + Quantization

## File 1: app/api/auto-manage/run/route.ts

```diff
 export async function POST(req: Request) {
   const now = new Date().toISOString();
   try {
     const source = req.headers.get("x-run-source") || "unknown";
     const runId = req.headers.get("x-run-id") || "";

     let force = false;
     try {
       const body = await req.json().catch(() => ({}));
       force = body?.force === true;
     } catch {}

     const result = await runAutoManage({ source, runId, force });
     return NextResponse.json(result, { status: 200 });
   } catch (err: any) {
     return NextResponse.json(
       { ok: false, now, error: err?.message || "auto_manage_failed" },
       { status: 500 }
     );
   }
 }
+
+export async function GET(req: Request) {
+  const now = new Date().toISOString();
+  try {
+    const { searchParams } = new URL(req.url);
+    const source = req.headers.get("x-run-source") || "unknown";
+    const runId = req.headers.get("x-run-id") || "";
+
+    // Support force=1, ignoreMarket=1, or force=true query params
+    const force =
+      searchParams.get("force") === "1" ||
+      searchParams.get("force") === "true" ||
+      searchParams.get("ignoreMarket") === "1";
+
+    const result = await runAutoManage({ source, runId, force });
+    return NextResponse.json(result, { status: 200 });
+  } catch (err: any) {
+    return NextResponse.json(
+      { ok: false, now, error: err?.message || "auto_manage_failed" },
+      { status: 500 }
+    );
+  }
+}
```

---

## File 2: lib/autoManage/engine.ts

### Change A: Type Definition (line 8)
```diff
 export type AutoManageResult = {
   ok: true;
   skipped?: boolean;
   reason?: string;
   checked: number;
   updated: number;
   flattened: number;
   enabled: boolean;
   now: string;
   market?: any;
   notes?: string[];
+  forced?: boolean;
   cfg: ReturnType<typeof getAutoManageConfig>;
 };
```

### Change B: Return Statement (line 245)
```diff
   const notesCapped = notes.slice(0, 50);
-  return { ok: true, checked, updated, flattened, enabled: true, now, market: clock, notes: notesCapped, cfg };
+  return { ok: true, checked, updated, flattened, enabled: true, now, market: clock, notes: notesCapped, forced: force ? true : undefined, cfg };
```

### Change C: Stop Sync Logging (lines 160-195)
```diff
   if (changedStop) {
     const res = await syncStopForTrade(next[idx], nextStop);
     if (res.ok) {
       next[idx] = {
         ...next[idx],
         quantity: res.qty,
         stopPrice: nextStop,
         stopOrderId: res.stopOrderId,
         autoManage: {
           ...(next[idx].autoManage || {}),
           lastStopSyncAt: now,
           lastStopSyncStatus: "OK",
           lastStopSyncCancelled: res.cancelled,
         },
         updatedAt: now,
         error: undefined,
       };
+      if (res.quantizationNote) {
+        notes.push(`quantize:${ticker}:${res.quantizationNote}`);
+      }
     } else {
       stopSyncOk = false;
       stopSyncNote = `${res.error}${res.detail ? ":" + res.detail : ""}`;
+      if (res.quantizationNote) {
+        stopSyncNote += ` [${res.quantizationNote}]`;
+      }
       next[idx] = {
         ...next[idx],
         autoManage: {
           ...(next[idx].autoManage || {}),
           lastStopSyncAt: now,
           lastStopSyncStatus: "FAIL",
           lastStopSyncError: stopSyncNote,
         },
         updatedAt: now,
       };
     }
   }
```

---

## File 3: lib/autoManage/stopSync.ts

### Change A: Type Definition (line 22)
```diff
 export type StopSyncResult =
-  | { ok: true; qty: number; stopOrderId: string; cancelled: string[] }
-  | { ok: false; error: string; detail?: string };
+  | { ok: true; qty: number; stopOrderId: string; cancelled: string[]; quantizationNote?: string }
+  | { ok: false; error: string; detail?: string; quantizationNote?: string };
```

### Change B: Quantization Tracking (lines 122-145)
```diff
   const stopSide = side === "SHORT" ? "buy" : "sell";

   // Normalize stop price to ensure tick compliance
   const entryPrice = num(trade.stopPrice) ?? 0; // Use current stop as fallback for directional check
   const tick = tickForEquityPrice(entryPrice);
   const normResult = normalizeStopPrice({
     side,
     entryPrice,
     stopPrice: nextStopPrice,
     tick,
   });

   if (!normResult.ok) {
     return {
       ok: false,
       error: "stop_normalization_failed",
       detail: `reason=${normResult.reason} original=${nextStopPrice} normalized=${normResult.stop || "N/A"}`,
     };
   }

+  // Check if quantization changed the price significantly
+  const quantizationDiff = Math.abs(normResult.stop - nextStopPrice);
+  let quantizationNote: string | undefined;
+  if (quantizationDiff > 0.0001) {
+    quantizationNote = `price_adjusted_for_tick_compliance: ${nextStopPrice} -> ${normResult.stop} (diff: ${quantizationDiff.toFixed(6)})`;
+  }
+
   const stopOrder = await createOrder({
     symbol: ticker,
     qty,
     side: stopSide,
     type: "stop",
     time_in_force: "day",
     stop_price: normResult.stop,
     extended_hours: false,
   });

-  return { ok: true, qty, stopOrderId: String((stopOrder as any)?.id || ""), cancelled };
+  return { 
+    ok: true, 
+    qty, 
+    stopOrderId: String((stopOrder as any)?.id || ""), 
+    cancelled,
+    quantizationNote,
+  };
```

---

## Summary

| File | Lines Changed | Type | Impact |
|------|---------------|------|--------|
| app/api/auto-manage/run/route.ts | +24 | Add GET handler | Support query params for force flag |
| lib/autoManage/engine.ts | +9 | Enhance type + logging | Include forced flag + quantization notes |
| lib/autoManage/stopSync.ts | +19 | Add quantization tracking | Debug notes for price adjustments |
| **Total** | **+52 lines** | | |

---

## Key Additions

1. **GET /api/auto-manage/run?force=1** - Bypass market closed gating
2. **forced?: boolean** in response - Audit trail when force used
3. **quantizationNote?: string** in StopSyncResult - Debug tracking
4. **Quantization logging** in engine notes - Track price adjustments > 0.0001

---

## Testing Examples

```bash
# Force run when market closed
curl "http://localhost:3000/api/auto-manage/run?force=1"

# Response includes:
# "forced": true,
# "notes": ["quantize:AAPL:price_adjusted_for_tick_compliance: 24.0591 -> 24.06 ..."]

# Check specific query params
curl "http://localhost:3000/api/auto-manage/run?ignoreMarket=1"
curl "http://localhost:3000/api/auto-manage/run?force=true"
```

---

## Backward Compatibility

✅ All changes are additive - no breaking changes
✅ Existing calls work as before
✅ Optional response fields only present when relevant
✅ Engine logic unchanged - only additions for forcing and logging
