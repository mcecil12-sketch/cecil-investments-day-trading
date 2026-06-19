# Agent Patch fcedb647-ec0d-4f25-b1c1-e96c5e42d1ab

## Title
Eliminate stale signal drag

## Summary
+0.4R to +1.1R/day. Signal freshness strongly correlates with valid setup persistence at execution time.

## Copilot Prompt
Performance opportunity task. Owner=performance. Improve metric bottleneck for "Eliminate stale signal drag". Use beforeMetrics baseline and ship measurable improvements without touching broker execution logic.

## Patch Plan Summary
Eliminate stale signal drag (CRITICAL) — +0.4R to +1.1R/day

## Patch Targets
- app/api/performance/analytics/route.ts
- app/api/performance/portfolio/route.ts
- lib/agents/trading-kpis.ts

## Validation Plan
- buildRequired: true
- testCommands: npm run test
- smokeChecks: GET /api/funnel-health | GET /api/agents/state | GET /api/agents/brief/latest

## Commit Plan
- commitMessage: agent: Eliminate stale signal drag
- targetBranch: main
- pushDirect: true

## Generated At
2026-06-19T14:08:04.744Z
