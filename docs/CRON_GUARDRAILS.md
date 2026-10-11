# Cron Guardrails

No new Vercel cron jobs on Hobby.
The market-loop workflow is the only scheduler.
`finalize-closes` is inline-only and must run inside the market-loop workflow.

Allowed GitHub Actions endpoints:
- `POST /api/scan?mode=ai-seed`
- `POST /api/auto-entry/seed-from-signals`
- `POST /api/auto-entry/execute`
- `POST /api/auto-manage/run`
- `POST /api/maintenance/finalize-closes`
- `POST /api/performance/snapshot`

Required headers for scheduled calls:
- `x-cron-token` for all cron-protected routes.
- `x-run-source` with value `github-actions`.
- `x-run-id` unique per run.
- Endpoint-specific auth headers (for example `x-scanner-token`, `x-auto-entry-token`) when required.

## Monthly scan timing and health (2026-10-11)

The monthly scan piggybacks on `/api/cron/refresh-candidate-universe`
(`maxDuration` 240s, run via `waitUntil`). Guardrails:

- **Log first, enrich second.** Rows are written before the paced insider pass.
  The pass has a wall-clock deadline, `INSIDER_PASS_DEADLINE_MS` (200s, measured
  from the start of the cron route function), and stops cleanly, leaving
  unattempted rows with `insiderFetchedAt = null`. Complete a partial run with
  `POST /api/agents/monthly-scan/enrich-insider` (PIN-gated).
- **Rehearse before Nov 1:** `POST /api/agents/monthly-scan?dryRun=1` (Agents
  page "Dry run") runs everything with real pacing, writes nothing, and reports
  duration vs the 240s limit.
- **Health results:** each cron-triggered monthly scan, each weekly scan and
  each weekly brief records a `ScanHealth` row. Read it at
  `GET /api/agents/scan-health`, on the Agents page, or in the snapshot export.
- **Silent Claude fallbacks are no longer silent:** missing
  `APP_ANTHROPIC_API_KEY`, API errors and billing/credit errors in the CIO
  brief, news-sentiment notes and Performance Analyst are recorded as health
  reasons (behavior unchanged). The Anthropic account has no auto-funding, so a
  credit-balance error shows up here as `BILLING/CREDIT`.
- **Optional alert email:** if both `RESEND_API_KEY` and `ALERT_EMAIL` are set, a
  short email is sent on DEGRADED/FAILED only (`ALERT_FROM_EMAIL` optionally
  overrides the sender). If either is missing, nothing is sent. No new env vars
  are required.
- No cron schedules changed; no new Vercel cron entries.
