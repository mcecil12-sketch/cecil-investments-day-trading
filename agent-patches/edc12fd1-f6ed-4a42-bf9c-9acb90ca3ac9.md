# Agent Patch edc12fd1-f6ed-4a42-bf9c-9acb90ca3ac9

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
2026-06-17T14:13:59.478Z
