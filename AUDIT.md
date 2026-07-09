1# Portfolio Intelligence Platform — Codebase Audit

Date: 2026-07-09
Scope: Pre-build audit of `cecil-investments-day-trading` against the new mission — a benchmark engine that measures portfolio performance against the S&P 500, covering five accounts (multiple Fidelity taxable brokerage, Verizon Savings Plan 401k, Verizon Mid-Atlantic legacy 401k, Verizon EDP locked/monitor-only), fed by weekly CSV position imports, with fund-specific and stock-specific scoring paths.

---

## 1. What currently exists

This repo is a fully-built **intraday day-trading automation system**, not a portfolio tool. Everything in it is oriented around one simulated $100k Alpaca paper-trading account making LONG/SHORT equity trades on multi-minute timeframes.

### Core domains present

- **Scanner/Signals** (`lib/scanner/`, `lib/signals*`, `app/api/scan/*`) — intraday breakout/compression/VWAP scanners that generate trade signals
- **AI Scoring** (`lib/aiScoring.ts`, `lib/ai/*`) — OpenAI-based signal grading (A/B/C tiers), bidirectional LONG/SHORT scoring
- **Auto-Entry / Auto-Manage** (`lib/autoEntry/*`, `lib/autoManage/*`) — automated order placement, stop management, cut-loss logic, circuit breakers, guardrails
- **Broker integration** (`lib/alpaca.ts`, `lib/broker/*`) — Alpaca REST client, order execution, position reconciliation, protective-stop verification
- **Risk** (`lib/risk/*`) — emergency flatten, stop verification, protection integrity
- **Agents / self-modifying engineering system** (`lib/agents/*`, `agent-patches/` — **1,556 files, 6.2MB**) — an autonomous engineering-manager loop that writes its own patches, incident reports, and backlog. This is a large, separate subsystem for *automating the day-trading bot's own development*.
- **Performance** (`lib/performance/*`, `app/(app)/performance/`) — computes equity curve, win rate, drawdown for the single paper account, using `startingBalance = 100000` hardcoded and Alpaca `/v2/positions` for unrealized P&L
- **Persistence** — hybrid: Upstash Redis (primary, via `lib/redis.ts`, `lib/jsonDb.ts`) + flat JSON files in `data/` (`trades.json`, `settings.json`) + a nearly-unused Prisma/SQLite schema with just `Trade` and `Signal` models
- **~42 root-level scratch markdown files** (`IMPLEMENTATION_SUMMARY.md`, `STOP_RESCUE_*.md`, etc.) — session-artifact clutter from the agent loop, not real documentation
- **GitHub Actions** (`.github/workflows/`) — cron jobs driving the market-open loop, auto-entry, auto-manage, score-drain, backlog-worker

### Confirmed absent

- No CSV import of any kind
- No multi-account model
- No S&P 500 / benchmark concept — the only "SPY" hits found are just a ticker inside the intraday scan universe, not benchmarking infrastructure
- No fund-vs-stock distinction
- No 401k / locked-account modeling

---

## 2. What stays, what's repurposed, what gets deleted

### Keep as-is (infra, not domain-coupled)

- Next.js app shell, Tailwind config, `AppShell.tsx` / `BottomNav.tsx` navigation pattern
- Redis client setup (`lib/redis.ts`, `lib/redis/ttl.ts`) — fine as a cache/session layer for the new platform
- `lib/time/etDate.ts` if market-calendar-aware date math is useful (S&P closes on the same calendar)
- Auth pattern (`lib/auth.ts`, `app/api/login`, `APP_PIN`) if a simple PIN-gated access model is still wanted

### Repurpose with heavy rework

- `lib/performance/math.ts` / `tradeStats.ts` — the return/drawdown math primitives are generic enough to reuse for portfolio-vs-benchmark comparison, but `portfolioSnapshot.ts` itself is single-account, Alpaca-coupled, and hardcodes a $100k paper balance — not reusable directly
- `app/(app)/performance/` page as a UI shell/chart pattern (recharts is already a dependency) — gut the data logic, keep the layout instinct

### Delete (day-trading-specific, no path to the new mission)

- `lib/autoEntry/*`, `lib/autoManage/*`, `lib/scanner/*`, `lib/signals*`, `lib/aiScoring.ts`, `lib/risk/*`, `lib/broker/*`, `lib/alpaca*.ts`, `lib/tradeEngine.ts`, `lib/tradePlan.ts`, `lib/trades/*`, `lib/scorecard/*`
- All corresponding `app/api/*` routes (auto-entry, auto-manage, scan, signals, trades, scorecard, ai-*)
- The entire `lib/agents/*` self-modifying engineering-manager subsystem and `agent-patches/` (1,556 files) — this was infrastructure for automating *this specific bot's* development loop; it has no role in a portfolio benchmarking tool
- All `.github/workflows/*` cron jobs tied to market-open trading loops
- The 42 root-level scratch `.md` files (implementation logs from the old agent loop)
- Prisma `Trade` / `Signal` schema — wrong shape entirely (no accounts, no positions, no fund/stock split, no historical NAV)
- `@alpacahq/alpaca-trade-api` dependency (unless kept purely as an S&P 500/quote data source later, which is a stretch — better to source index data elsewhere)
- `openai` dependency, unless AI-generated commentary on scores is wanted later (defer that decision)

**Net effect:** this is closer to starting a new app inside the same repo shell than "evolving" the existing one. Almost none of the domain logic survives; what survives is scaffolding (Next.js config, Tailwind, Redis client, nav shell).

---

## 3. What needs to be built from scratch

### Data model (the real design work)

- **`Account`** — id, name, type (`FIDELITY_TAXABLE`, `VZ_SAVINGS_401K`, `VZ_LEGACY_401K`, `VZ_EDP`), institution, `isLocked` (true only for EDP — monitor-only, no trade/rebalance actions ever assumed possible); supports **multiple** Fidelity taxable accounts as distinct rows, not a single bucket
- **`Holding` / `Position`** — account_id, symbol or fund identifier, quantity, cost basis, as-of date, tied to a specific **weekly snapshot** (not real-time)
- **`ImportBatch` / `Snapshot`** — a weekly CSV upload event: source file, upload date, as-of date, per-account parse status/errors — this is the primary ingestion path, so it needs first-class modeling, not a side utility
- **`Instrument`** — symbol, name, `type` (`FUND` vs `STOCK`), and fund-specific metadata (expense ratio, category, benchmark index if a fund tracks something other than the S&P) — this split drives which scoring path applies
- **`BenchmarkSeries`** — S&P 500 historical daily values, needed for every comparison; requires picking a data source (decision point — nothing in this repo currently touches index data)
- **`Score` / `ScoreResult`** — the fund-scoring and stock-scoring outputs, versioned by the week's snapshot so history isn't overwritten

### Ingestion

- CSV parser(s) — Fidelity's export format and the Verizon/plan-provider export format are almost certainly different schemas and will need separate mapping logic, unified into the common `Holding` shape
- Validation/reconciliation — detect a week where an account's total doesn't reconcile, flag partial imports

### Scoring

- Fund-specific scoring path (expense ratio, category-relative performance, tracking vs. its own benchmark if not S&P)
- Stock-specific scoring path (can reuse relative-return-vs-S&P math, but needs different peer/risk context than a fund)

### Benchmark engine (the stated first priority)

- Portfolio-level and per-account time-weighted or money-weighted return calculation from weekly snapshots — a genuinely different math problem than the old day-trading equity curve: sparse weekly points, deposits/withdrawals to account for, and a locked account (EDP) that should probably be excluded or clearly segmented from "actionable" performance
- S&P 500 return over the same weekly windows
- Delta/attribution output, applied uniformly across every account view and the aggregate view

### Presentation

- New pages/routes for account list, weekly import, per-account and aggregate benchmark views — none of the current pages map onto this.

---

## Open decision before implementation

Given how little survives, the repo-structure question needs to be settled before writing code:

1. **Fresh app in same repo** — delete the day-trading domain code (`lib/autoEntry`, `autoManage`, `scanner`, `signals`, `agents`, `agent-patches`, scratch `.md` files, old Prisma schema) and build the portfolio platform in the same Next.js shell, reusing only infra (Redis client, nav shell, Tailwind config).
2. **New repo, retire this one** — start a clean repository for the portfolio platform; leave this repo frozen/archived as-is for reference. Avoids any risk of leftover coupling or accidentally-kept dead code, at the cost of losing the existing Next.js/Redis scaffolding to copy from scratch.
3. **New folder/workspace inside this repo** — keep the day-trading system fully intact and untouched (e.g. as a separate app or package), and add the portfolio platform alongside it as an independent app in the same repo. Higher short-term overhead (two systems to reason about) but zero risk to the existing trading bot.
