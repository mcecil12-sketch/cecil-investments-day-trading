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
- `fragilityPercentile` — mean of the cohort percentile ranks (0-100, mid-rank
  for ties) of `extensionVs200d` and `vol60d` within the scan's ranked cohort
  (monthly: the 30 ranked candidates; weekly: the top 15). Added Oct 11 2026.
- `fragilityFlag` — true if `fragilityPercentile` is in the top third of the
  cohort (at/above the `ceil(m/3)`-th highest; ties at the cut all flagged;
  null for a cohort under 3).

**Oct 11 2026: absolute thresholds flagged 60% of candidates, no discriminating
power; redefined as relative before any outcome data existed.** The original
(Oct 6, STX postmortem, hypothesis only) rule — `extensionVs200d >= 0.25` OR
`vol60d >= 0.60` — is SUPERSEDED; the constants stay in
`lib/agents/fragilityScore.ts` for reference only. The raw `extensionVs200d`
and `vol60d` are still logged unchanged. Rows logged before this change have a
null `fragilityPercentile` and carry the superseded flag, so the Performance
Analyst excludes them from the flagged-vs-unflagged comparison (the two
definitions never mix). The factor is **not**
in the composite, ranking, or banding; the Ranked Candidates table shows a
muted "Fragile" badge only. The Performance Analyst compares flagged vs.
unflagged closed Group 3 positions (average forward return, and return per
unit of `vol60d`) and reports nothing until at least 3 monthly cycles and 10
closed positions carry fragility data.

**Pre-registered graduation rule:** Graduates only if, across at least 3
monthly cycles, flagged names underperform unflagged on risk-adjusted return.
If it graduates, apply as a position-size haircut in recommendations, not as
a rank penalty.

### Log first, enrich second (2026-10-11)

The monthly scan used to run the slow, paced insider fetch (~30 calls at 1.2s)
before writing the log, so a timeout could lose the whole month. Now:

1. The scan scores/ranks and `logMonthlyScanBatch` writes all rows with insider
   fields **null** and `insiderFetchedAt` **null**.
2. `enrichInsiderForLatestMonthlyScan()` (`lib/agents/insiderEnrichment.ts`) then
   fetches insider data and updates rows by id. It sets `insiderFetchedAt` on
   every row it attempts — including failures and empty responses — so
   *not attempted* (`null`) is distinguishable from *attempted, no data*
   (set, insider fields null).
3. It stops cleanly at `INSIDER_PASS_DEADLINE_MS` (200s from the start of the
   route function) and never throws; unattempted rows stay `null`.
4. It is idempotent/resumable: only rows with `insiderFetchedAt` null are touched.
   Finish a partial run with `POST /api/agents/monthly-scan/enrich-insider`
   (PIN-gated; `?retryFailed=1` also retries attempted-but-empty rows).

None of this touches the composite, ranks, banding, thresholds or the
`fragilityFlag` formula (tests assert the scoring output is unchanged).

**Dry run:** `POST /api/agents/monthly-scan?dryRun=1` (Agents page "Dry run"
button) runs the full pipeline including the paced insider pass but writes
nothing — no log rows, no `AgentRun`, no earnings/sentiment/S&P cache writes —
and returns per-phase timings, duration vs the 240s limit, counts, insider
counters and the top-10 table. It can never count toward the trading-readiness
banner.

**Scan health:** after each monthly scan (cron), weekly scan and weekly brief a
`ScanHealth` row (HEALTHY / DEGRADED / FAILED + reasons + metrics) is stored;
see `GET /api/agents/scan-health`, the Agents page status line, and the
snapshot export's Warnings. DEGRADED on: fewer than 30 monthly rows, >20% rows
with null `extensionVs200d`/`vol60d`, <80% rows with `insiderFetchedAt`, the
insider deadline hit, or any Claude failure (missing key, API/billing errors —
each recorded with its reason). FAILED on a thrown run or zero rows. Weekly
scans skip the expected-row-count and insider checks.

### Insider data source: SEC EDGAR primary, Alpha Vantage fallback (2026-10-12)

Alpha Vantage returned empty `data` for 28 of 30 ranked names on the Oct 11
dry run (including DELL, MU, AMD, NVDA), so coverage is unreliable. The enrich
pass now tries **SEC EDGAR first** (`lib/agents/edgarInsider.ts`), per ticker:
`company_tickers.json` (ticker -> CIK, cached 7 days) -> `data.sec.gov`
submissions JSON -> Form 4s filed in the last 30 days -> each filing's raw XML
-> non-derivative transactions (code, shares, price, acquired/disposed flag,
owner, title, date). Same rule as before: only `S` and `P` on non-derivative
common stock at a positive price count. If the filing carries the Rule 10b5-1
checkbox (`aff10b5One`, Form 4 since 2023) it is recorded, so planned sales
(`plannedSalesUsd`, shown in the dry-run panel) can be separated from
discretionary ones; `insiderHas10b5_1` is set from it (null when no filing has
the indicator).

- **Fair access:** User-Agent `CecilInvestments insider-research (<SEC_CONTACT_EMAIL>)`.
  **Set `SEC_CONTACT_EMAIL`** (a real contact address) in the environment; with
  it unset EDGAR is skipped and every ticker uses Alpha Vantage. Requests are
  spaced 220ms (< 5/s); HTTP 429/403 back off (2s, then 6s) and then fail; any
  non-200, non-JSON, or non-Form-4 body is a FAILURE, never zero rows.
- **Fallback:** EDGAR failure for a ticker (not configured, ticker not in the
  SEC map, throttled, bad response) -> Alpha Vantage for that ticker. Both fail
  -> FAILED. A valid empty EDGAR result stays "n/a" with `insiderFetchedAt` set
  and does not trigger the fallback.
- **Provenance:** `CandidateRecommendationLog.insiderSource` ("edgar" |
  "alphavantage"; null if not attempted or both failed), shown in the dry-run
  table with filings/requests per ticker and the EDGAR failure reason.
- **Time budget:** same `INSIDER_PASS_DEADLINE_MS` (200s). One ticker costs
  ~2 + (Form 4 filings in 30d) requests at ~4.5/s, so a name with 40 filings is
  ~9s; the dry run reports total HTTP requests and elapsed time and whether all
  names fit (`fitsTimeBudget`). If not, the pass stops cleanly mid-ticker
  (unattempted, not failed) and the `enrich-insider` route resumes it; it stays
  idempotent, and `?retryFailed=1` re-attempts rows that came back with no data.
- At most 100 filings per ticker are read (`truncatedFilings` is reported).

**10b5-1 audit (2026-10-13), real NVDA and DELL Form 4s.** The indicator is the
filing-level `<aff10b5One>` element (`1`/`0` on NVDA, `true`/`false` on DELL);
the plan itself is described in a `<footnote id="F1">…effected pursuant to a
Rule 10b5-1 trading plan adopted…</footnote>` that each sale row references via
`<footnoteId id="F1"/>` inside `<transactionCoding>`. The parser reproduced the
dry run exactly (NVDA $14.4M planned of $314.6M): the large NVDA sales carry
`aff10b5One=0` and no plan footnote, and DELL's large sales are Silver Lake
fund sales with `aff10b5One=false` — i.e. the low planned share is what the
filings say. Row-level footnote detection was added anyway (a row is planned if
the box is set OR one of its footnotes cites a plan, ignoring negations like
"not pursuant to a 10b5-1 plan"); tests use the real filings under
`lib/agents/__tests__/fixtures/`.

**"No filings" vs n/a.** A valid EDGAR result with no S/P Form 4 transaction in
the window is stored as `$0`, `insiderSaleCount30d = 0`, `insiderSource =
'edgar'` and shown as "$0 (no filings)". n/a is only for failed or unattempted
fetches and for Alpha Vantage's valid-but-empty responses (coverage unknown).
Scan health counts both toward "suspiciously empty" (> 80%).

**Market cap (logging-only).** Every scan row logs `scanClose` and `priceDate`
(the close the scan used). The monthly enrichment pass then stores `marketCap` =
Alpha Vantage OVERVIEW `SharesOutstanding` x `scanClose` (`marketCapSource`
`shares_x_close`; `av_reported` when shares are missing; `unavailable` on
failure, retried only with `?retryFailed=1`) and
`insiderNetSoldPctOfMarketCap` = net sold / market cap x 100 (percent,
positive = net selling). Weekly rows get `scanClose`/`priceDate` only.

### Insider selling (logging-only, monthly scan)

**Oct 11 2026 root-cause fix.** The first dry run showed $0 net sold for every
top name. Cause: Alpha Vantage's `acquisition_or_disposal` field carries the SEC
Form 4 *transaction code* (S sale, P purchase, M exercise, F tax withholding,
A award, G gift, ...), not the "A"/"D" flag the parser assumed, so no row ever
matched. Only `S` (sale) and `P` (purchase) of non-derivative securities now
count (STX: 101 sale rows / $206.6M net in 30d, vs $0 before). Separately,
several tickers (DELL, MU, AMD, NVDA) return a valid `{"data": []}` with no
history at all; that is recorded as **empty = "no data" (n/a, insider fields
null, `insiderFetchedAt` set)**, never as $0 sold. Responses with an
`Information`/`Note`/`Error Message` key, or without a `data` array, are
FAILED. Both the insider pass and the sentiment cron read
`ALPHA_VANTAGE_API_KEY`. Scan health adds a DEGRADED reason when more than 80%
of insider fetches come back empty (or more than 50% fail); the dry-run panel
shows per-ticker `rowsReturned / rowsInWindow / saleRowsCounted / net sold /
response keys`.

Added 2026-10-06 after STX's CEO sold stock under 10b5-1 plans on the day we
bought. For **all 30 ranked candidates** of the monthly scan (cron runs only, filled in by the second enrichment pass above;
weekly Group 1 rows and manual runs get nulls) we log, from
one Alpha Vantage `INSIDER_TRANSACTIONS` call per ticker
(`lib/agents/insiderActivity.ts`):

- `insiderNetSoldUsd30d` — trailing-30d sale dollars minus purchase dollars
  (shares x price per row; positive = net selling).
- `insiderSaleCount30d`, `insiderSellers30d` — sale transactions / distinct sellers.
- `insiderHas10b5_1` — **always null today**: the API has no plan indicator.

**Which rows count.** Only non-derivative security rows (e.g. "Ordinary
Shares") with a positive share price. `acquisition_or_disposal = D` is a sale;
`A` is a purchase only if the same insider has no derivative row (option / RSU /
PSU) that day (otherwise it is an option exercise at its strike). Awards and
vests (A at price 0), gifts (D at price 0) and all derivative rows are
excluded. **Known limit:** the response has no transaction code, so tax
withholding and exercise-and-sell lots at a positive price are counted as
sales. The figure is an upper bound on discretionary selling (for STX it
summed ~$226M over 30 days, far above the ~$27.7M CEO sale that motivated this).

**Budget.** Sequential at 1.2s pacing (about 50 requests a minute; no per-minute
plan limit is documented in the repo, so it is not raised), 30 calls per run,
with `INSIDER_MAX_CALLS_PER_RUN = 60` as a hard stop. As of 2026-10-06 the
Alpha Vantage key is assumed to be premium (stated by the owner, not verifiable
from the repo), so free-tier daily limits do not apply. Calls used are logged. A failed fetch writes nulls for that ticker and the scan
continues.

**Analysis.** The Performance Analyst's second cut is relative, not a dollar
threshold (Oct 6 2026, hypothesis only): within each monthly cohort it ranks
candidates by `insiderNetSoldUsd30d` and compares the top third against the
rest, over closed Group 3 positions. It reports nothing until 3 monthly cycles
and 10 closed positions carry insider data. Raw dollars stay logged unchanged;
because the figure is an upper bound, only the within-cohort ordering is used.

**Graduation rule (same as fragility):** graduates only if, across at least 3
monthly cycles, top-third insider-selling names underperform on risk-adjusted
return. If it graduates, apply as a position-size haircut in recommendations,
never as a rank penalty.

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
