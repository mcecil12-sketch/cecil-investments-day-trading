# Agent Patch adaptive-low_overall_win_rate-movwjpsq

## Title
[Adaptive] Overall win rate critically low (27%) over 34 trades — manual review needed before adjusting thresholds

## Summary
Performance-driven pattern detected: low_overall_win_rate. Requires manual review — not auto-applicable. Triggered reason: Overall win rate critically low (27%) over 34 trades — manual review needed before adjusting thresholds

## Copilot Prompt
Review and address performance pattern: low_overall_win_rate. Overall win rate critically low (27%) over 34 trades — manual review needed before adjusting thresholds

## Patch Plan Summary
[Adaptive] Overall win rate critically low (27%) over 34 trades — manual review needed before adjusting thresholds: Performance-driven pattern detected: low_overall_win_rate. Requires manual review — not auto-applicable. Triggered reason: Overall win rate critically low (27%) over 34 trades — manual review needed before adjusting thresholds

## Patch Targets
- app/api/agents/state/route.ts
- lib/aiMetrics.ts

## Validation Plan
- buildRequired: true
- testCommands: npm run test
- smokeChecks: GET /api/readiness | GET /api/auto-entry/summary

## Commit Plan
- commitMessage: agent: [Adaptive] Overall win rate critically low (27%) over 34 trades — manual review needed before adjusting thresholds [taskId:adaptive-low_overall_win_rate-movwjpsq]
- targetBranch: main
- pushDirect: true

## Generated At
2026-05-08T00:38:46.653Z
