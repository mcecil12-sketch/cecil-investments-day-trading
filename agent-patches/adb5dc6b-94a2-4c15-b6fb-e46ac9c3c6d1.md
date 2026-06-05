# Agent Patch adb5dc6b-94a2-4c15-b6fb-e46ac9c3c6d1

## Title
CRITICAL: Negative average R detected — review exit strategy

## Summary
Average realized R across recent closed trades is negative. Immediate review of stop management and exit discipline required.

## Copilot Prompt
Resolve NEGATIVE_R issue detected by trading health monitor

## Patch Plan Summary
Average realized R across recent closed trades is negative. Immediate review of stop management and exit discipline required.

## Patch Targets
- lib/agents/performanceLearning.ts
- lib/autoEntry/guardrails.ts
- lib/risk/protection-integrity.ts

## Validation Plan
- buildRequired: true
- testCommands: (none)
- smokeChecks: /api/performance/learning | /api/trades?view=closed

## Commit Plan
- commitMessage: agent: CRITICAL: Negative average R detected — review exit strategy
- targetBranch: main
- pushDirect: true

## Generated At
2026-06-05T15:12:18.387Z
