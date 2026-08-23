# Recommendation Tracking Groups

Three parallel, independently-tracked recommendation lenses, all reusing the
same underlying scoring building blocks (momentum/trend, earnings surprise
trend, sector leadership — the 39/33/28-weighted composite implemented in
`lib/agents/scoringShared.ts`).

## Group 1 — Weekly Candidate Scanner

Unchanged. The original weekly Top 15 (`lib/agents/candidateScanner.ts`),
logged unconditionally to `CandidateRecommendationLog` (`group: GROUP_1`).
Research/observation only — never tied to a live account.

## Group 2 — Zero-Miss Monthly Aggregation

A read-only report, not a scoring agent (`lib/agents/zeroMissAggregation.ts`).
For each calendar month, looks at every distinct weekly Group 1 batch logged
that month and surfaces only the symbols present in *every* one of them
(zero misses). Reports the snapshot count alongside the qualifying list so an
in-progress month is never mistaken for a final, confirmed result.
Research/tracking only — never used for live trading decisions.

## Group 3 — Monthly Scan (Rank-Banded)

A new monthly-cadence scoring agent (`lib/agents/monthlyScan.ts`) with
rank-based buy/sell/backfill banding (`lib/agents/monthlyScanBanding.ts`):
buy at rank ≤ `BUY_RANK_THRESHOLD` (10), sell only once a held position's
rank drops below `SELL_RANK_THRESHOLD` (20), backfill to
`TARGET_PORTFOLIO_SIZE` (10) if sells drop the count below it, capped at
`MAX_PORTFOLIO_SIZE` (15) — buys are capped rather than force-selling to hit
the ceiling. All four are plain, adjustable constants.

Momentum and sector-leadership reuse the exact same logic as Group 1, just
called monthly instead of weekly. Earnings-surprise-trend is
**quarterly-triggered, not calendar-triggered**
(`lib/agents/monthlyScanEarnings.ts`): earnings data only changes ~4x/year
regardless of how often the scoring loop runs, so recomputing that sub-score
every month a symbol hasn't reported would re-score identical inputs and
falsely imply a fresher signal than actually exists. It only recomputes when
`EarningsHistory.fiscalDateEnding` has advanced past what was last scored
(tracked per symbol in `MonthlyScanEarningsState`).

A separate, lightweight sector-risk-flag panel reuses the existing Sector
Rotation agent's output live (whatever cadence it actually runs at) —
independent of Group 3's own monthly cycle, so a mid-month sector break
isn't invisible for a full month.

**Point-in-time integrity:** each month's score is frozen from whatever data
was available at scan time and never retroactively restated once later data
arrives (e.g. a late-arriving earnings report). `MonthlyScanOutput` records
what was actually available per symbol (`dataAvailability`) for auditability.

**Trading readiness:** Group 3 is intended to become the human-actionable
recommendation source for the "For Kennedy" taxable account — a ranked
buy/hold/sell list a person acts on manually in Fidelity, **not** automated
trade execution (this app has no live execution engine; the old
auto-entry/bracket-order logic is fully archived in `_archive/v1-trading/`
and unwired). It's flagged "trading-ready" only once there's at least one
`COMPLETE` `MONTHLY_SCAN` run whose `triggerSource` is `"cron"` (the real
monthly cycle, piggybacked on the existing `refresh-candidate-universe` cron
— see that route's comments for why it doesn't get its own cron entry). A
manual/test run never counts toward this. See `/tracking-groups` for the
live readiness banner.

## Evaluation ground rules

No group is declared "better" than another based on early results. Minimum
evaluation horizon before drawing any conclusion is **3-6 months, ideally a
full year** — short-window outperformance is easy to mistake for skill when
it's actually noise (the multiple-comparisons risk this whole exercise is
explicitly trying to avoid by tracking three approaches openly rather than
picking a winner after the fact).

Each group's raw pick-quality performance is tracked independently (same
View 1/View 2 engine as the existing dashboard, in
`lib/agents/recommendationPerformance.ts`, parameterized by `group`) so they
can eventually be compared apples-to-apples once enough history exists — not
before.
