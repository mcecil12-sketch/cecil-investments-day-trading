# Agent Patch profit-negative_avg_r-morcoivf

## Title
[ProfitEngine] Optimize exit strategy — negative avgR

## Summary
Average R across 25 trades is -0.099. Add exit quality diagnostics to performance scorecard and identify R-drag patterns.

## Copilot Prompt
Performance optimization task (exit_optimization). Target files: app/api/performance/analytics/route.ts, app/api/performance/scorecard/route.ts, lib/agents/performanceLearning.ts. Add diagnostics, metrics, and safe threshold adjustments only. DO NOT modify order execution, stop logic, or broker integration.

## Patch Plan Summary
Average R across 25 trades is -0.099. Add exit quality diagnostics to performance scorecard and identify R-drag patterns.

## Patch Targets
- app/api/performance/analytics/route.ts
- app/api/performance/scorecard/route.ts
- lib/agents/performanceLearning.ts

## Validation Plan
- buildRequired: true
- testCommands: npm run test
- smokeChecks: GET /api/performance/analytics | GET /api/performance/scorecard | GET /api/readiness

## Commit Plan
- commitMessage: agent: [ProfitEngine] Optimize exit strategy — negative avgR [optimizationType:exit_optimization] [taskId:profit-negative_avg_r-morcoivf]
- targetBranch: main
- pushDirect: true

## Generated At
2026-05-04T19:32:25.060Z
