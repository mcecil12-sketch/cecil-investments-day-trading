  # Verizon LTI Plan Account — Revised Plan (Grant-Level Tracking)

  Revision to [verizon-lti-plan-account.md](verizon-lti-plan-account.md): the data source and data model change based on what's actually available from Fidelity. Read-only plan — no code written yet.

  Reusing the provided example data (RD24/RD25/RD26) as a validation check: total shares = 1,653.52 + 1,448.02 + 1,447.97 + 1,216.27 + 1,216.27 + 1,217.30 = **8,199.35 shares**. Against a $411,771.36 balance, that implies a VZ price of ~$50.22/share — a plausible current VZ price, which confirms "shares × current price" is the right reconstruction of that top-line number rather than something Fidelity computes some other way.

  ## Import source (new)

  Fidelity's Stock Plans tab is a separate document from the Positions/Performance PDFs — new import path, not riding the existing weekly PDF pipeline. Mirror the existing two-step pattern already used for the Performance PDF (`extract` → `confirm`), just with its own extractor: a new route (e.g. `app/api/import/vz-lti/route.ts` + `confirm`) that takes a Stock Plans screenshot (or manual entry) and extracts `{ cohortLabel, vestDate, shares }` per remaining tranche.

  ## Data model — grant/vest tranches, not a flat balance

  New table, batch-scoped exactly like `Holding` is (one snapshot per import, latest batch = current truth — no cross-batch upserting, no manual pruning of vested-out thirds: a third just stops being recreated once it's no longer on Fidelity's page):

  ```
  model VzLtiTranche {
    id            String      @id @default(cuid())
    account       Account     @relation(fields: [accountId], references: [id])
    accountId     String
    importBatch   ImportBatch @relation(fields: [importBatchId], references: [id])
    importBatchId String
    cohortLabel   String      // "RD24", "RD25", "RD26"
    grantYear     Int         // 2024, 2025, 2026 — parsed from cohortLabel, stored for sorting
    vestDate      DateTime    // always a March 1
    shares        Float       // shares remaining unvested in this specific third, as of this batch

    @@index([accountId, vestDate])
    @@unique([importBatchId, cohortLabel, vestDate])
  }
  ```

  Today's example data becomes 6 rows in one batch: RD24×1, RD25×2, RD26×3 — matching Fidelity's own per-grant-per-vest-year structure directly, so the account detail page can render it as a real grant/vest schedule table instead of a flat number.

  ## Deriving the balance (not manually entered)

  The import captures **shares per tranche only** — not Fidelity's own dollar valuation of each tranche. Balance is computed by the app: sum shares across all tranches in the latest batch, multiply by VZ's current price (reusing the same daily-close price-fetch mechanism already used elsewhere in the app, e.g. for S&P 500/momentum — no new live-quote integration). This keeps LTI's valuation on the same price basis as everything else that touches VZ (the concentration flag, momentum scoring), rather than trusting Fidelity's internal valuation timestamp, which could use a slightly different price snapshot.

  **One thing to confirm:** "derived... at each update" — read here as *computed once per import, then frozen until the next screenshot*, same as every other account's snapshot (so the displayed balance doesn't silently drift between imports depending on when the page happens to load). If the intent is instead to re-price live on every page view using the latest cached price, that's a different, slightly bigger change (the value would no longer be tied to a single frozen `ImportBatch`).

  ## Wiring into the existing calculation paths

  - **`getAccountSnapshot` / `toSnapshotValue` (`lib/benchmark/portfolioValue.ts`):** add a branch for `VZ_LTI` — instead of summing `Holding.currentValue`, sum `VzLtiTranche.shares` for the latest batch and multiply by VZ's price at import time. Combined with the full-lock decision from the prior plan, `lockedValue = totalValue` entirely for this account type.
  - **`getCurrentHoldings()` (`lib/agents/holdings.ts`):** rather than synthesizing a redundant `Holding` row just to make LTI visible to Risk Manager/Relative Strength/Sector Rotation, extend this function to also fold each `VZ_LTI` account's derived shares/value into the `"VZ"` instrument bucket directly. One source of truth (the tranche table), no risk of a duplicate derived row drifting out of sync with it. This is what makes the concentration flag (#1) and the severity-tiered locked-stock flag (#2) from the prior plan pick up LTI automatically, same as before.
  - **`sincePurchase` / `aggregateSincePurchase` (`lib/benchmark/engine.ts`):** these compute a "return since cost basis," and LTI has no real purchase cost basis — it's compensation. Proposing to exclude `VZ_LTI` from this calc entirely (similar to how EDP is already excluded from `planFundComparison`), rather than inventing a synthetic cost basis that would either show a nonsensical +∞% (basis = $0) or a meaningless flat 0% (basis = current value).
  - **Account detail page:** for `VZ_LTI`, render the grant/vest table (cohort, vest date, shares, value at current price) instead of a Holdings table — gives a natural home for the March-distribution note from the prior plan too.

  ## Still stands from the prior plan, unchanged

  `VZ_LTI` account type + migration, `isLocked: true` default, full-lock in actionable value by account type (not instrument-name matching), severity-tiered concentration flag on check #2, and the `getCurrentHoldings()` holdings-filter bug fix (now folded into the same function change described above).

  ## Open decisions

  1. Frozen-at-import vs. live-recomputed-on-view for the derived balance (leaning frozen-at-import, for consistency with every other account).
  2. Excluding `VZ_LTI` from the since-purchase return calc entirely (leaning yes — no real cost basis exists).
  3. Folding LTI into `getCurrentHoldings()`'s "VZ" bucket vs. writing a synthesizing `Holding` row (leaning fold-in — single source of truth).
