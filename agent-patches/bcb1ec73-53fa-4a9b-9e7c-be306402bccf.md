# Agent Patch bcb1ec73-53fa-4a9b-9e7c-be306402bccf

## Title
Investigate underutilized funnel

## Summary
High candidate count but low seeding. Check scoring thresholds, capacity constraints, and guardrail settings. Context: High candidate count (3265) but only 0 seeded (capacity allows 3). Check scoring thresholds or capacity constraints.

## Copilot Prompt
Resolve UNDERUTILIZED_FUNNEL incident: High candidate count (3265) but only 0 seeded (capacity allows 3). Check scoring thresholds or capacity constraints.

## Patch Plan Summary
High candidate count but low seeding. Check scoring thresholds, capacity constraints, and guardrail settings. Context: High candidate count (3265) but only 0 seeded (capacity allows 3). Check scoring thresholds or capacity constraints.

## Patch Targets
- app/api/funnel-health/route.ts
- app/api/readiness/route.ts
- app/api/auto-entry/seed-from-signals/route.ts
- lib/autoEntry/guardrails.ts

## Validation Plan
- buildRequired: true
- testCommands: (none)
- smokeChecks: /api/funnel-health | /api/readiness | /api/auto-entry/seed-from-signals

## Commit Plan
- commitMessage: agent: Investigate underutilized funnel
- targetBranch: main
- pushDirect: true

## Generated At
2026-05-01T16:19:19.096Z
