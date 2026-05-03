# Agent Patch adaptive-scoring_quality_degraded-molj8kco

## Title
[Adaptive] Win rate 28% critically low — scoring prompt review needed

## Summary
Performance-driven pattern detected: scoring_quality_degraded. Requires manual review — not auto-applicable. Triggered reason: Win rate 28% critically low — scoring prompt review needed

## Copilot Prompt
Review and address performance pattern: scoring_quality_degraded. Win rate 28% critically low — scoring prompt review needed

## Patch Plan Summary
[Adaptive] Win rate 28% critically low — scoring prompt review needed: Performance-driven pattern detected: scoring_quality_degraded. Requires manual review — not auto-applicable. Triggered reason: Win rate 28% critically low — scoring prompt review needed

## Patch Targets
- (none)

## Validation Plan
- buildRequired: true
- testCommands: npm run test
- smokeChecks: GET /api/readiness | GET /api/auto-entry/summary

## Commit Plan
- commitMessage: agent: [Adaptive] Win rate 28% critically low — scoring prompt review needed
- targetBranch: main
- pushDirect: true

## Generated At
2026-05-03T02:05:40.735Z
