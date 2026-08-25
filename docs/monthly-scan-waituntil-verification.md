# Group 3 monthly scan: `waitUntil()` fix + verification (2026-08-24)

Context: `app/api/cron/refresh-candidate-universe/route.ts` piggybacks Group 3's
monthly scan (`runAndPersistMonthlyScan`) onto the existing candidate-universe
refresh cron (see `docs/CRON_GUARDRAILS.md` — no new cron jobs on Hobby). The
monthly scan had never actually completed a verified run in prod (0 `AgentRun`
rows with `agentType: 'MONTHLY_SCAN'`, ever), and the original wiring fired it
as a bare detached promise with no Vercel-documented guarantee it survives
past the HTTP response. This closes that reliability gap before Group 3
becomes the actionable reference for Kennedy account trades.

## 1. `waitUntil()` added

`app/api/cron/refresh-candidate-universe/route.ts` now wraps the monthly scan
call:

```ts
waitUntil(
  runAndPersistMonthlyScan("cron").catch((err) => {
    console.error("Post-universe-refresh monthly scan failed:", err);
  }),
);
```

replacing the bare detached-promise `.catch()` pattern. Added
`@vercel/functions` as a dependency.

## 2. maxDuration interaction — real ceiling, not extra time

Verified against Vercel's docs directly rather than assumed: **`waitUntil()`
does not grant extra execution time.** Per the `@vercel/functions` docs:
*"Promises passed to `waitUntil()` will have the same timeout as the function
itself. If the function times out, the promises will be cancelled."* And
`getDeadline()`'s docs confirm the invocation deadline "includes request
processing and asynchronous `waitUntil` tasks."

So this reintroduces the original risk for real — universe refresh + monthly
scan now share the same 60s budget, and if exceeded, the monthly scan gets
killed mid-flight with no partial-completion handling. That's why empirical
measurement (below) was mandatory, not optional.

## 3–4. End-to-end verified run — real numbers, not an assumption

Ran the actual production functions directly against the prod DB (the same
one this route uses):

| Step | Duration | Result |
|---|---|---|
| Universe refresh | 729ms | COMPLETE |
| Monthly scan | 30,701ms (~30.7s) | COMPLETE |
| **Combined** | **31.4s** | **28.6s headroom under the 60s ceiling** |

Not "barely under" — comfortable margin. The `AgentRun` row persisted
correctly: `agentType: MONTHLY_SCAN`, `status: COMPLETE`, 30 ranked
candidates, 0 skipped, 0 sectors without universe. No silent truncation.

### Side finding: manual test runs aren't excluded from Group 3's trading logic

The verification run used `triggerSource: "manual"` (not `"cron"`), then the
30 `CandidateRecommendationLog` rows it wrote were deleted afterward (the
`AgentRun` completion record was kept intact). Reason: `logMonthlyScanBatch`
and `monthlyScanBanding`'s replay logic have **no `triggerSource` filter at
all** — they operate on any `GROUP_3` batch tagged with the current month. A
manual test run left in place would have been silently replayed as a real
month in Group 3's buy/sell banding and shown on the tracking-groups
page/performance stats, corrupting the exact "clean run" history this
verification was meant to establish.

This is a separate latent gap — manual reruns in prod aren't excluded from
the trading logic — independent of the `waitUntil` fix above. Worth fixing
before Group 3 sees more ad hoc manual reruns in production.

## 5. Go-live gate

Step 3 succeeded — one confirmed, verified `AgentRun` now exists
(`MONTHLY_SCAN`, `COMPLETE`, `id: cmt6onb5200049p59ot4d3upi`). Note it's
`triggerSource: "manual"`, and the tracking-groups page's readiness banner
specifically requires `triggerSource === "cron"` — so this confirms the
pipeline *works and fits comfortably in the time budget*, but doesn't itself
flip the go-live banner. That still needs the real cron cycle on
2026-09-01, now running through the `waitUntil`-protected path with 28.6s of
measured headroom.

## 6. Manual-run pollution fix (2026-08-24, follow-up)

The side finding above was fixed before Group 3 goes live: `logMonthlyScanBatch`
(`lib/agents/monthlyScanRecommendationLog.ts`) now returns immediately when
`output.triggerSource !== "cron"`, before writing any
`CandidateRecommendationLog` rows. This is the single choke point — the only
call site is `runAndPersistMonthlyScan` — so manual/test runs can never reach
the table `monthlyScanBanding.ts`'s replay logic and the tracking-groups
performance display read from. No downstream filter was needed in
`monthlyScanBanding.ts` itself: once the write path is guarded, there is
nothing non-cron in the table left to filter out. No cleanup step is
required for future manual reruns.

Added a regression test
(`lib/agents/__tests__/monthlyScanRecommendationLog.test.ts`) asserting
`logMonthlyScanBatch` persists for `triggerSource: "cron"` and no-ops for
`triggerSource: "manual"`.

**Re-verified empirically** (not just by test): ran `runAndPersistMonthlyScan("manual")`
again end to end against prod.

| Check | Before | After | Result |
|---|---|---|---|
| `AgentRun` (`MONTHLY_SCAN`) | — | `COMPLETE`, `triggerSource: "manual"`, 30 ranked candidates | persisted correctly |
| `CandidateRecommendationLog` (GROUP_3) row count | 0 | 0 | **PASS** — no rows written |
| Banding replay input (`groupIntoMonthlyRankings`) | 0 months | 0 months | **PASS** — unchanged |
| `buildBandedMonthlyPositions` output | 0 positions | 0 positions | **PASS** — unchanged |

This run's `AgentRun` row was left in place (not deleted) as proof the
filter works, per the point of this fix: no manual cleanup should ever be
needed again.

### Does the same gap exist in Group 1 or Group 2?

No — checked both, and neither has the same failure mode, for different reasons:

- **Group 1** (`logCandidateRecommendationBatch`, weekly Candidate Scanner /
  Top 15): has no `triggerSource` concept at all. `runAndPersistCandidateScanner()`
  is "shared by the manual API route [`/api/agents/candidates`,
  `/api/agents/risk-manager`] and the auto-trigger fired after a successful
  import, so both paths save results identically" — by design, not by
  omission. Group 1 has no equivalent "trading-ready, cron-only" gate the way
  Group 3 does, so there's no landmine of a manual run silently impersonating
  a real cron cycle — every invocation was already meant to be treated as
  real data. Worth knowing: a manual test hit against
  `/api/agents/risk-manager` in prod does create a permanent, real
  `top15-YYYY-MM-DD` batch with no way to mark it as a test — but that's
  existing, intentional behavior, not a regression to fix here.
- **Group 2** (`zeroMissAggregation.ts`): explicitly documented as "Never
  used for live trading decisions — research/tracking only." It aggregates
  whatever Group 1 already logged (GROUP_1 rows only), so it inherits Group
  1's "every invocation is real" property but has no buy/sell banding logic
  of its own for a manual run to corrupt — worst case, a manual Group 1 test
  run adds one extra snapshot to a read-only zero-miss report, not a real
  trading decision.

Group 3 was the only one of the three with both (a) a `triggerSource: cron |
manual` distinction implying manual runs should be excluded, and (b) actual
buy/sell banding logic acting on that data — which is what made the gap
dangerous there specifically.

**Group 3 is now clear to go live on the 2026-09-01 cron cycle**, pending
that real run actually landing and showing `triggerSource: "cron"` in the
tracking-groups readiness banner.
