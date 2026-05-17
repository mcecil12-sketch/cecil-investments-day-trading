# Agent Patch db6fbdbd-14a3-4761-b6da-a5ab504f3bd9

## Title
CRITICAL: Risk breach — realized R below -2R threshold

## Summary
A trade exceeded the -2R maximum loss threshold. Review stop placement and risk controls immediately.

## Copilot Prompt
Resolve RISK_BREACH issue detected by trading health monitor

## Patch Plan Summary
A trade exceeded the -2R maximum loss threshold. Review stop placement and risk controls immediately.

## Patch Targets
- lib/risk/protection-integrity.ts
- lib/risk/stop-verification.ts
- app/api/trades/protection-audit/route.ts

## Validation Plan
- buildRequired: true
- testCommands: (none)
- smokeChecks: /api/trades/protection-audit?enforce=1 | /api/trades?view=closed

## Commit Plan
- commitMessage: agent: CRITICAL: Risk breach — realized R below -2R threshold
- targetBranch: main
- pushDirect: true

## Generated At
2026-05-17T09:40:17.186Z
