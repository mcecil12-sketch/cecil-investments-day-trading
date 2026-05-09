# Agent Patch bb9ccedd-23f1-4b03-9cb3-2eb73d8c5cbb

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
2026-05-09T12:29:28.751Z
