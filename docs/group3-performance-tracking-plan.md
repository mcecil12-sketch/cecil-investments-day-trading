    # Group 3 Performance-Tracking Plan (Top 10 / Top 30)

    Planning doc for adding a Group 1-style performance-tracking view for Group 3, comparable to the existing "View 1 — Pure Pick Quality" / "View 2 — Simulated Position-Sized Portfolio" pair, but split into two independent series: Top 10 (bought/held) and Top 30 (full ranked list). Read-only plan — no code written yet.

    **Key finding:** the Top 10 (bought/held) view essentially already exists. `getRecommendationPerformance(null, "GROUP_3")` is already called in `getGroup3State()` (`app/tracking-groups/page.tsx:54`) and already renders through `<RecommendationPerformanceCharts>` on that page today, using `buildBandedMonthlyPositions` under the hood. The real net-new work is the Top 30 series.

    ## 1. How View 1 / View 2 adapt to Group 3

    - **View 2 (Simulated Portfolio) → maps cleanly to Top 10 only.** `getRecommendationPerformance` is already group-parameterized: for `GROUP_3` it swaps `buildTrackedPositions(groupIntoWeeklyBatches(...))` for `buildBandedMonthlyPositions(groupIntoMonthlyRankings(...))` (`recommendationPerformance.ts:360-361`) and everything downstream (pick quality, $ sizing, realized P&L on sells) is unchanged. This is the "how did the positions I'm actually holding for Kennedy perform" view, and it's already live. Carry-forward, backfill-to-10, and cap-15 are all handled automatically because `buildBandedMonthlyPositions` already encodes those rules — no new logic needed here.
    - **View 1 (Pure Pick Quality) → needs a second, new position set for Top 30.** The existing `buildPickQualityPoint`/`buildTrackedPositions` machinery assumes either weekly presence/absence (Group 1) or banded buy/hold/sell (Group 3 Top 10). Neither is "every ranked candidate, bought or not." That's a new, third position-construction function — call it `buildFullRankTrackedPositions` — sibling to `buildTrackedPositions` and `buildBandedMonthlyPositions`, operating on the same `MonthlyRanking[]` input.
    - Cadence: nothing timeframe-related needs to change. `TIMEFRAME_DAYS` windows in calendar days already work correctly against sparse monthly data (trailing-N-days anchored to the series' own last point) — verified this already works for the existing Top 10 chart with a single Sept 1 point.

    ## 2. Top 10 vs Top 30 as independent series

    Confirmed: Top 30 must **not** be "Top 10 filtered out of the Top 30 chart" — it needs its own independent position list, built from a function that includes **all 30** symbols per batch, not just the ≤10 that passed banding. Concretely:

    - Top 10 → `buildBandedMonthlyPositions(groupIntoMonthlyRankings(rows))` (already exists, unchanged).
    - Top 30 → new `buildFullRankTrackedPositions(groupIntoMonthlyRankings(rows))`, which tracks every row in every monthly batch regardless of rank, independent of the Top 10 banding state machine.

    These feed two separate `getRecommendationPerformance`-shaped results, so they render as two structurally distinct chart cards, not one chart with a derived subset.

    **Layout recommendation:** stacked cards on `/tracking-groups`, same pattern the page already uses (Group 1/2/3 are stacked cards) — not a toggle. A toggle would risk implying they're two views of the same underlying number, when the whole point is that they answer different questions (execution quality vs. model quality) and should be visible/comparable at the same time, especially since discrepancy between them (model ranks well, banding underperforms, or vice versa) is itself a signal worth seeing side-by-side. Concretely:
    - Card: "Group 3 — Top 10 (Bought/Held)" → View 1 + View 2, exactly as today.
    - Card: "Group 3 — Top 30 (Full Ranked List)" → View 1 only (pick quality vs S&P), no simulated $ portfolio — sizing 30 unbought candidates against a hypothetical portfolio doesn't map to anything real and would invite exactly the confusion you're trying to avoid for the Kennedy account.

    ## 3. Single-data-point (Sept 1) behavior

    The existing `RecommendationPerformanceCharts` component already degrades correctly with one point — verified this is how the current Top 10 chart behaves today: `totalPositions > 0` gates rendering, the timeline still emits one row, and the "Tracking N positions since {date}" line reads correctly (`app/dashboard/RecommendationPerformanceCharts.tsx:154-158`, generic across groups). Same will hold for the new Top 30 series with no extra code:
    - Today: "Tracking 30 positions since Sep 1, 2026" with a single marker on each chart, S&P 500 comparison line also present as a single point (or a short backfilled line to "today" since the timeline extends from entryDate to now using SPX's own daily series — this already happens for Top 10, e.g. the chart currently shows a short line from Sept 1 to Sept 3ish, not just a dot).
    - After Oct 1: second monthly point appears, connecting into an actual line, and month-over-month pick quality becomes visible. No code changes needed for this transition — it's the same timeline-accumulation logic Group 1 already relies on weekly.

    ## 4. Reuse vs. new code

    Reuse (no changes needed):
    - `groupIntoMonthlyRankings`, `buildBandedMonthlyPositions`, `getRecommendationPerformance` (Top 10 path) — already wired.
    - `RecommendationPerformanceCharts.tsx` — reusable as-is for both new Top 10 (already using it) and a stripped-down Top 30 instance (pass `simulatedPortfolio: []` or add a `showSimulatedPortfolio` prop to suppress View 2's card when not applicable, rather than forking the component).
    - `CandidateRecommendationLog` schema — **no new schema**. `rank` is already populated 1-30 for every GROUP_3 row (verified against the actual Sept 1 batch: all 30 rows have `rank` set), so Top 30 pick quality can be built directly off existing data.

    New code required:
    - `buildFullRankTrackedPositions` in `monthlyScanBanding.ts` (or a new sibling file) — the Top 30 position-construction function.
    - A second `getRecommendationPerformance`-style entry point, or a parameter/variant on the existing one, to run pick-quality-only aggregation against the Top 30 position set instead of the banded one (View 2's $ sizing and realized-P&L machinery doesn't apply here — this path only needs `buildPickQualityPoint`/`computeWindowedPickQuality`, not `buildRealizationEvents`).
    - A prop on `RecommendationPerformanceCharts` (or a lighter sibling component) to hide View 2 when rendering the Top 30 card.
    - Wiring in `getGroup3State()` / `app/tracking-groups/page.tsx` to fetch and render the second card.

    This is a small, additive change — no migrations, no new tables, no changes to the cron/scan/logging path.

    ## 5. Edge cases in Group 3's banding vs. Group 1's simpler model

    - **Sold position (rank drops below 20, previously held):** Top 10 view — already correctly closes it via existing `buildBandedMonthlyPositions` sell logic; its realized P&L folds into the simulated portfolio going forward (existing `buildRealizationEvents`). Top 30 view — if it's still ranked ≤30 that month (e.g. now rank 25), it keeps tracking there uninterrupted; the two views can legitimately disagree at the same point in time (closed in Top 10, still open in Top 30), and that's correct, not a bug.
    - **Never-bought hold-band symbol (stays ranked 11-30 every month, never crosses into Top 10):** Top 10 view — correctly never appears. Top 30 view — tracks continuously the entire time; this is exactly the case the Top 30 view exists to surface ("model likes it, banding never acted on it").
    - **Symbol drops out of the Top 30 entirely (e.g. falls to rank 35), then re-enters later:** needs an explicit rule for `buildFullRankTrackedPositions`, since Group 1's grace-period model (1 missed week = noise, 2 consecutive closes it) was tuned for weekly cadence — a month is a much bigger gap. Recommendation: no grace period for Top 30 — close immediately on any month it's absent from the top 30, and treat re-entry as a brand-new position with a fresh cost basis (same "fresh position on re-entry" convention Group 1 already uses, just without the 1-miss forgiveness, since monthly absence is a much stronger signal than a single missed week).
    - **First-cycle-only quirk (specific to today):** with one data point, Top 10 and Top 30 will look artificially "aligned" (Top 10 is literally a subset of Top 30's top 10 ranks right now) — worth a UI note or just relying on the "tracking since Sept 1" framing so it isn't mistaken for the two views agreeing/validating each other before there's any real divergence to observe.

    ## Net effort

    Roughly one new pure function + one new/adapted aggregation entrypoint + a UI prop tweak + page wiring. No schema changes, no changes to the scan/cron/logging pipeline.

    ## Decisions (confirmed)

    - Layout: stacked cards on `/tracking-groups` (not a toggle or side-by-side) — "Group 3 — Top 10 (Bought/Held)" and "Group 3 — Top 30 (Full Ranked List)" as two separate cards.
    - Top 30 re-entry rule: no grace period — a symbol closes immediately the first month it's absent from the top 30, and re-entry later starts a brand-new position with a fresh cost basis.
