# Agent Patch bef3b70a-f7de-49c9-adcf-7cbe39ae0f24

## Title
Fix execute payload validation blocking seeded AUTO_PENDING trades

## Summary
Execute route is rejecting all seeded AUTO_PENDING trades with rescore_required or MALFORMED. Seeded trades carrying a valid aiScore and tier must not require a second AI rescore at execute time. Fix: ensure per-trade normalization (symbol/ticker/aiScore/tier cross-population) runs before eligibility evaluation, and that isScoredTrade/rescoreAfterMin gate honours existing seed-validated scores.

## Copilot Prompt
seeded=1 executed=0 eligibleCount=0 | executeSkipReasonBreakdown={"SKIPPED_NO_LONGER_ELIGIBLE":1}

## Patch Plan Summary
Execute route is rejecting all seeded AUTO_PENDING trades with rescore_required or MALFORMED. Seeded trades carrying a valid aiScore and tier must not require a second AI rescore at execute time. Fix: ensure per-trade normalization (symbol/ticker/aiScore/tier cross-population) runs before eligibility evaluation, and that isScoredTrade/rescoreAfterMin gate honours existing seed-validated scores.

## Patch Targets
- app/api/auto-entry/execute/route.ts
- lib/autoEntry/eligibility.ts
- app/api/auto-entry/seed-from-signals/route.ts

## Validation Plan
- buildRequired: true
- testCommands: (none)
- smokeChecks: /api/auto-entry/execute | /api/auto-entry/seed-from-signals | /api/funnel-health

## Commit Plan
- commitMessage: agent: Fix execute payload validation blocking seeded AUTO_PENDING trades
- targetBranch: main
- pushDirect: true

## Generated At
2026-06-08T21:00:34.624Z
