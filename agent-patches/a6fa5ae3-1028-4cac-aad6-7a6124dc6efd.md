# Agent Patch a6fa5ae3-1028-4cac-aad6-7a6124dc6efd

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
2026-05-30T05:24:57.011Z
