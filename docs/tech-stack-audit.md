# Tech Stack Audit — cecil-investments

_Generated 2026-08-19_

Note: the repo contains an active app at root plus an archived old app in `_archive/v1-trading/`. Findings below are for the **active app** unless noted.

## 1. Database — Neon Postgres (confirmed)
- `DATABASE_URL` in `.env.local` resolves to `ep-dark-haze-aimrr7iu-pooler.c-4.us-east-1.aws.neon.tech` — this is Neon's pooled connection endpoint.
- Accessed via Prisma (`@prisma/client` + `prisma`), `prisma/schema.prisma` datasource is `postgresql` with separate `url` (pooled) and `directUrl` (for migrations).
- A `db-keepalive` cron (`vercel.json`, weekdays 21:58 UTC) exists specifically to ping Neon and prevent it from auto-suspending — a strong signal this is Neon's **free/scale-to-zero tier**, not a paid always-on plan.
- Used for all app data: accounts, portfolio positions, recommendations, benchmark/performance data, earnings estimates, weekly briefs, etc.

## 2. Hosting/Deployment — Vercel (likely, unconfirmed locally)
- `vercel.json` defines 4 cron jobs (candidate-universe refresh monthly, db-keepalive weekdays, earnings-estimates twice weekly, weekly-brief on Sundays) — Vercel Cron is a Vercel-specific feature, so this app is built to deploy there.
- **No `.vercel/` folder exists in this workspace**, so it isn't linked to a Vercel project locally — can't determine which Vercel account/team it's under from this environment. Check the Vercel dashboard directly, or run `vercel link` in an authenticated shell.
- `CRON_SECRET` env var exists and is checked in each cron route, consistent with Vercel's cron-auth pattern.

## 3. Authentication — none in the active app
- No Clerk, NextAuth, Supabase Auth, or similar dependency in `package.json`.
- `APP_PIN` / `CHAT_INTAKE_TOKEN` (simple PIN-based custom auth) exist only in the **archived** `_archive/v1-trading/lib/auth.ts` — not referenced anywhere in the active `app/`/`lib/` tree. The current app appears to have **no authentication layer**.

## 4. AI/LLM providers — both configured, in active use
- `@anthropic-ai/sdk` and `openai` are both dependencies, used in `lib/agents/newsSentiment.ts`, `lib/agents/cio.ts`, and PDF/screenshot import routes (`app/api/import/*`) — likely OCR/parsing + scoring/commentary generation split across providers.

## 5. Market data — Alpaca + Alpha Vantage
- `@alpacahq/alpaca-trade-api` used in `lib/agents/marketData.ts` and `lib/agents/fundMappings.ts` for market/fund data.
- `ALPHA_VANTAGE_API_KEY` configured in `.env.local` (likely a supplementary data source; free tier is standard for this key).

## 6. Notifications — Pushover
- `lib/notifications/weeklyBrief.ts` sends push notifications via Pushover for the weekly CIO brief and trade alerts.
- `PUSHOVER_USER_KEY` / `PUSHOVER_API_TOKEN` are documented in the README but **not currently set** in `.env` or `.env.local` — wired up in code but not actively configured right now (notifications silently no-op per the README's documented fallback).

## 7. Caching/queue — Upstash Redis (dependency only, unused)
- `@upstash/redis` is a listed dependency but there are **no usages** found in the active `app/`/`lib/` code — appears to be either leftover from the pivot or not yet wired in.

## 8. Error tracking / analytics — none found
- No Sentry, PostHog, Segment, Datadog, LogRocket, or similar in dependencies or code.

## 9. Email/SMS — none found
- No Resend, SendGrid, Mailgun, Twilio dependency or usage.

## Summary table

| Service | Purpose | Status |
|---|---|---|
| Neon (Postgres) | Primary database (all app data) | Active, likely free/scale-to-zero tier (keepalive cron confirms this) |
| Vercel | Hosting + cron scheduler | Configured in code; not locally linked, can't confirm account |
| Anthropic API | LLM (agents, import parsing) | Active |
| OpenAI API | LLM (agents, import parsing) | Active |
| Alpaca | Market data | Active |
| Alpha Vantage | Market data | Configured, likely free tier |
| Pushover | Push notifications | Wired in code, **not currently configured** (no keys set) |
| Upstash Redis | — | Dependency present, **unused** in code |
| Auth provider | — | **None** — no auth in active app |
| Error tracking | — | **None** |
| Email/SMS | — | **None** |

## How this was determined
- `package.json` dependencies list
- `.env` / `.env.local` variable names (values not inspected/echoed)
- `vercel.json` cron config; absence of `.vercel/` folder
- `prisma/schema.prisma` datasource block
- Codebase grep for provider SDKs/env var usage, scoped to active `app/`/`lib/` (excluding `_archive/`)
