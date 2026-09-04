# Verizon LTI Plan Account — Plan

Planning doc for adding the Verizon LTI Plan (long-term incentive stock grants) as a new account, distinct from the existing Verizon EDP account. Read-only plan — no code written yet.

Context on how LTI actually works:
- Annual grant each April, currently ~$175k, awarded entirely in VZ stock.
- Quarterly dividends are reinvested into additional VZ shares within the account (compounding the position, not paid out as cash).
- Each year's grant vests/pays out over the following 3 years in equal thirds, distributed annually each March.
- So any given March distribution = 1/3 of the prior year's grant + 1/3 of the grant from 2 years prior + 1/3 of the grant from 3 years prior (three overlapping vesting cohorts paying out simultaneously).
- Distributions are paid out net of taxes, directly into a separate brokerage account — money leaves LTI and appears elsewhere.
- The account is 100% single-stock VZ exposure the entire time it's held.

I dug into how `VZ_EDP` is actually treated today (not just the account-type name) since the LTI account behaves differently enough that reusing EDP's exact mechanism would be wrong in a couple of places. Two things found along the way need a decision before building.

## 1. New account type

Add `VZ_LTI` to the `AccountType` enum (alongside `VZ_EDP`, `VZ_SAVINGS_401K`, etc.) — a migration, not a big lift. Add it to `NewAccountForm.tsx`'s dropdown (`{ value: "VZ_LTI", label: "Verizon LTI Plan (locked)" }`), defaulting `isLocked: true` on creation, same as EDP does today (`isLocked: type === "VZ_EDP"` → extend to also match `"VZ_LTI"`). `isLocked` currently only drives the "Monitor Only" badge and hides the 1Y alpha figure on `/accounts` — it doesn't by itself exclude dollars from anywhere, so it's safe to set without side effects.

## 2. Total Portfolio Value / net worth rollup

This is automatic — `computeBenchmark()`'s `totalCurrentValue` sums every account with a usable holdings snapshot, with no allowlist of account types. Once the account exists with a `Holding` row, it's in the net worth number for free.

**But:** `lib/agents/holdings.ts`'s `getCurrentHoldings()` — used by Risk Manager, Relative Strength, and Sector Rotation — has the **exact same bug** fixed previously in `getAccountSnapshot`: it picks the latest `ImportBatch` by date without checking that batch actually has any `Holding` rows. Right now, today, this means those three agents are silently seeing **zero holdings** for every account whose latest batch is this week's holdings-less Performance PDF import (i.e. every account except Gifts and Trips). This directly undermines requirement #4 below (the concentration flag runs on this same data), so it needs the same one-line fix (`holdings: { some: {} } }`) as part of this work rather than separately. Flagging it here since it's scope creep on a literal reading of "add an account," but the concentration flag won't fire correctly without it.

## 3. Excluding from allocation/diversification/rebalancing

Worth naming precisely: this app has no rebalancing/execution engine and no generic "allocation" feature. The real mechanism is `actionableValue` (`totalValue` minus `lockedValue`) in `lib/benchmark/portfolioValue.ts`, which feeds the `AGGREGATE_ACTIONABLE` blended rollup — that's "the number that matters for reallocation decisions."

Today, `lockedValue` is computed **per instrument**, by matching the instrument's name/symbol against the literal string `"VERIZON STOCK"` (`lib/benchmark/lockedHoldings.ts`) — a hack that works for EDP's captive 401k "Verizon Stock Fund," which sits alongside genuinely actionable diversified funds in the same account. LTI is different: it's 100% VZ, always, with nothing else to separate out.

The plan had been to just reuse that same instrument-match mechanism for LTI's real VZ shares, but a landmine turned up while checking: there's already a stale `Instrument` row with **symbol `"VZ"` but name `"VERIZON STOCK FUND"`** — a mislabeled duplicate from a superseded July 25 EDP import (one dead `Holding` row, not on any current batch). If LTI's import naturally resolves to ticker `VZ` (correct), it would either collide with this mislabeled row (LTI's real common stock would display as "VERIZON STOCK FUND," which is wrong) or, if that row's name gets cleaned up to something accurate, it would stop matching the `"VERIZON STOCK"` needle and LTI would silently NOT be excluded from actionable value at all.

**Proposal:** don't lean on the fragile name-matching hack for LTI. Add an explicit check in `toSnapshotValue`: for `VZ_LTI` accounts, treat 100% of `totalValue` as `lockedValue` (vs. EDP's continued per-instrument partial lock, unchanged). This is a few lines, doesn't touch EDP's existing partial-actionable behavior, and doesn't depend on instrument-name string matching. Separately, fix that stale `"VZ"` instrument's name as a small piece of housekeeping (one `UPDATE`, one dead row, zero behavior change since nothing live references it).

## 4. Concentration risk flag, sized appropriately

`riskManager.ts` already has two relevant checks:
- **Check #1 (generic concentration, critical >30% of total portfolio, by symbol)** — already scales its wording to actual dollars/percentage and already runs across all holdings including locked ones. Once #2's `getCurrentHoldings()` fix lands, this will fire on its own once LTI (+ EDP's existing VZ slice) crosses 30% of net worth — no LTI-specific code needed here.
- **Check #2 ("locked-stock," the informational flag referenced in the request)** — currently **always severity `"informational"` regardless of size**. EDP's ~$37K/~4%-of-portfolio slice and a hypothetical $300K+/~25%-of-portfolio LTI balance would render with the identical low-key severity today. That's the actual gap.

**Proposal:** add size-based severity tiers to check #2 itself (e.g. informational under ~10% of portfolio, watch 10–20%, critical above 20% — exact thresholds up for discussion), the same threshold-constant pattern already used for every other check in this file. This scales generically by dollars for *any* locked stock position, so EDP's small slice keeps reading as low-key while LTI's larger and growing one escalates automatically as it grows — rather than a special case that only applies to LTI by name.

## 5. Data model for the rolling 3-year vest

v1 should be a flat current-balance snapshot via the existing `ImportBatch`/`Holding` mechanism, updated manually like every other account (one `Holding` row: quantity = shares, currentValue = $, instrument = VZ). No new tables for v1.

For the record, what full vest-schedule tracking would take later: a small `VzLtiGrant` table (grantDate, grantValueAtGrant or sharesGranted, thirdsVested/thirdsRemaining), with current balance derived as a rollup instead of a manual entry, and the March distribution calculated (not just noted) from the two most recent cohorts. That's a real second phase, not a tweak — noted for the record, not building it now.

## 6. March distribution — handling the expected drop

Since v1 has no grant-by-grant data to compute the *expected* drop size, this shouldn't be a computed flag yet — it'd either be wrong or need the very tracking deferred in #5. Cheapest correct option: a static, account-type-conditional note wherever LTI's balance is shown (same pattern EDP already uses for its own bespoke banner text on `/accounts` and elsewhere) — something like *"Balance drops each March as prior grants' vesting thirds pay out net of tax to a separate account — an expected distribution, not a market loss."* No schema change, no computation, just context at the point where a March drop would otherwise look alarming.

## Summary of what would actually be touched

One enum value + migration, `NewAccountForm.tsx`, `portfolioValue.ts` (the LTI-full-lock branch + the `getCurrentHoldings()` filter fix), `riskManager.ts` (severity tiers on check #2), one stale-data cleanup (`Instrument` rename), and a small static UI note. No new tables, no rebalancing engine, no vest-schedule automation.

## Open decisions for review

- Does fixing `getCurrentHoldings()`'s holdings-filter bug as part of this work (rather than separately) sound right?
- Does the full-lock-by-account-type approach in #3 (vs. reusing/relying on instrument-name matching) sound right?
- Do the proposed severity tiers on check #2 in #4 sound right, and if so, what thresholds?
