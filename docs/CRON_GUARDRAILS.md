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
