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
hard top 10 only, no grace band (changed 2026-10-02; previously a 10-point
whipsaw buffer let a held position drift to rank 20 before selling) — buy at
rank ≤ `BUY_RANK_THRESHOLD` (10), sell the moment a held position's rank is
11 or worse (`SELL_RANK_THRESHOLD`, 10), backfill to `TARGET_PORTFOLIO_SIZE`
(10) if sells drop the count below it, capped at `MAX_PORTFOLIO_SIZE` (10) —
buys are capped rather than force-selling to hit the ceiling. All four are
plain, adjustable constants.

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

## Fragility factor (logging-only)

Added 2026-10-06 after the STX postmortem (ranked #2 on the Oct 1 scan, then
fell ~14% in a week): the composite (momentum/trend, SUE earnings, sector
leadership) is entirely backward-looking and rewards extended names. Every
`CandidateRecommendationLog` row (Group 1 weekly and Group 3 monthly) now
logs, from the price history the scan already fetched (no new network calls):

- `extensionVs200d` — `(lastClose / SMA200) - 1`; null under 200 daily bars.
- `vol60d` — annualized stdev of daily log returns over 60 bars; null under 60.
- `fragilityFlag` — true if `extensionVs200d >= 0.25` OR `vol60d >= 0.60`.

Thresholds are named constants in `lib/agents/fragilityScore.ts`, set from the
STX postmortem — hypothesis only, validate before use. The factor is **not**
in the composite, ranking, or banding; the Ranked Candidates table shows a
muted "Fragile" badge only. The Performance Analyst compares flagged vs.
unflagged closed Group 3 positions (average forward return, and return per
unit of `vol60d`) and reports nothing until at least 3 monthly cycles and 10
closed positions carry fragility data.

**Pre-registered graduation rule:** Graduates only if, across at least 3
monthly cycles, flagged names underperform unflagged on risk-adjusted return.
If it graduates, apply as a position-size haircut in recommendations, not as
a rank penalty.

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
