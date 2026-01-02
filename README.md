This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Environment

### Auto Entry Guardrails

- `AUTO_ENTRY_ENABLED` (default `true`): global toggle for auto entry.
- `AUTO_ENTRY_MAX_OPEN_POSITIONS` (default `3`): limit concurrent open auto trades.
- `AUTO_ENTRY_MAX_ENTRIES_PER_DAY` (default `5`): maximum submissions per NY trading day.
- `AUTO_ENTRY_COOLDOWN_AFTER_LOSS_MIN` (default `20`): minutes to wait after a loss before new entries.
- `AUTO_ENTRY_TICKER_COOLDOWN_MIN` (default `30`): cooldown between entries for the same ticker.
- `AUTO_ENTRY_MAX_CONSECUTIVE_FAILURES` (default `3`): triggers circuit breaker when exceeded.

### Notifications

- `NOTIFY_ENABLED` (default `true`): master switch for notification delivery.
- `NOTIFY_PAPER_ENABLED` (default `true`): allow notifications for paper trades.
- `NOTIFY_LIVE_ENABLED` (default `false`): allow notifications for live trades.
- `NOTIFY_EVENTS` (CSV, default `AUTO_ENTRY_PLACED,AUTO_ENTRY_FAILED,AUTO_ENTRY_DISABLED,TRADE_CLOSED,STOP_HIT`): allowlist of event types to send.
- `NOTIFY_TIER_MIN` (default `C`): minimum tier (`A`, `B`, or `C`) required to trigger notifications.
- `NOTIFY_DEDUPE_TTL_SEC` (default `3600`): TTL used when deduping notifications per event key.

### Pushover

- `PUSHOVER_USER_KEY`: recipient key for Pushover messages.
- `PUSHOVER_API_TOKEN` / `PUSHOVER_APP_TOKEN`: API or app token used to post notifications.
