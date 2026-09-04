# Group 3 — Sept 1, 2026 Monthly Scan Output

Verification report: actual ranked output of Group 3's first live monthly scan cycle, pulled directly from the database (not just the readiness banner).

## 1. Where the list is surfaced

`/tracking-groups` (`app/tracking-groups/page.tsx`) — the "Group 3 — Monthly Scan (Rank-Banded)" card. This is a separate page from the main dashboard and from Group 1's page. The table shows Rank / Symbol / Score / Status (HELD or `—`), rendered live from the DB on each page load. There is no dedicated Group-3-only route; it's one card among three (Group 1, Group 2, Group 3) on this shared tracking-groups page.

## 2. Full Sept 1 output

Source batch: `batchTag: "monthly-2026-09"`, `recommendedAt: 2026-09-01T06:01:04Z`, 30 rows.

| Rank | Symbol | Score | Sector | Banding |
|---|---|---|---|---|
| 1 | DELL | 68 | Technology | BUY |
| 2 | MU | 66 | Technology | BUY |
| 3 | VLO | 65 | Energy | BUY |
| 4 | MPC | 64 | Energy | BUY |
| 5 | ANET | 63 | Technology | BUY |
| 6 | AMGN | 63 | Healthcare | BUY |
| 7 | BKR | 62 | Energy | BUY |
| 8 | PSX | 61 | Energy | BUY |
| 9 | NVDA | 61 | Technology | BUY |
| 10 | MRNA | 61 | Healthcare | BUY |
| 11 | SNDK | 59 | Technology | hold-band (not held) |
| 12 | STX | 59 | Technology | hold-band |
| 13 | CAH | 59 | Healthcare | hold-band |
| 14 | MRVL | 58 | Technology | hold-band |
| 15 | BMY | 58 | Healthcare | hold-band |
| 16 | SLB | 57 | Energy | hold-band |
| 17 | AAPL | 57 | Technology | hold-band |
| 18 | LRCX | 57 | Technology | hold-band |
| 19 | WDC | 57 | Technology | hold-band |
| 20 | TMO | 57 | Healthcare | hold-band |
| 21 | COP | 56 | Energy | sell-band |
| 22 | AMD | 56 | Technology | sell-band |
| 23 | CRWD | 56 | Technology | sell-band |
| 24 | DVN | 55 | Energy | sell-band |
| 25 | OXY | 55 | Energy | sell-band |
| 26 | REGN | 55 | Healthcare | sell-band |
| 27 | MRK | 54 | Healthcare | sell-band |
| 28 | CVX | 51 | Energy | sell-band |
| 29 | TRGP | 51 | Energy | sell-band |
| 30 | OKE | 51 | Energy | sell-band |

Verified against the actual `buildBandedMonthlyPositions` / `currentlyHeldSymbols` logic in `lib/agents/monthlyScanBanding.ts` (not just eyeballed rank thresholds) — output matches what the UI renders.

Source AgentRun: `cmti9dpgp0004jq04rutuzhli`, `MONTHLY_SCAN`, started `2026-09-01T06:00:45.097Z`, completed `2026-09-01T06:01:04.736Z` (19.6s — consistent with prior AgentRun evidence), `triggerSource: "cron"`, `skipped: []`.

## 3. Net-new vs. carried-forward vs. sell

This is the only GROUP_3 batch in the database — first live cycle, as expected. Result:

- **10 buys, all net-new**: DELL, MU, VLO, MPC, ANET, AMGN, BKR, PSX, NVDA, MRNA (ranks 1–10). Nothing was held before this cycle, so the backfill-to-`TARGET_PORTFOLIO_SIZE` (10) rule and the plain rank≤10 buy rule collapsed onto the same set. All 10 are currently open/held positions.
- **0 carried-forward**: no prior month, no prior positions, so carry-forward doesn't apply yet.
- **0 sell signals**: the rank > 20 rows (21–30) are not actual sells. The sell rule only fires against symbols already held, and nothing was held going in. Ranks 11–30 (20 symbols) are simply not bought this cycle — they sit outside the top 10 and are not tracked positions.

## 4. Independence from Group 1

Confirmed structurally, not just by convention:

- Group 1's list lives at `/recommendations`, sourced from `AgentRun` where `agentType: "CANDIDATE_SCANNER"` — it never reads `CandidateRecommendationLog` rows for its display.
- Group 3's list lives on `/tracking-groups`, sourced from `CandidateRecommendationLog` rows filtered to `group: "GROUP_3"`, populated by a distinct `agentType: "MONTHLY_SCAN"` AgentRun.
- On `/tracking-groups`, Group 1 only gets a summary (last-run timestamp + a link out to `/recommendations`); its full list is never rendered there or merged with Group 3's table.
- `CandidateRecommendationLog.group` defaults to `GROUP_1` specifically so old rows and all Group-1 code paths are unaffected by Group 3's addition (per the schema comment).

No overlap, no overwrite — the two groups are independently stored and independently rendered as designed.
