import {
  appendAgentAction,
  appendAgentBrief,
  getOpenBacklogItems,
  listEngineeringTasks,
  listBacklogItems,
  readAgentState,
  updateEngineeringTaskById,
  upsertEngineeringTask,
  writeAgentState,
  writeBacklog,
} from "@/lib/agents/store";
import { prepareExecutionPlan } from "@/lib/agents/execution/engine";
import { approveExecution } from "@/lib/agents/governance/manager";
import { buildPriorityFeed, type PerformanceOpportunity } from "@/lib/agents/opportunity-engine";
import { getSharedTradingKpis } from "@/lib/agents/trading-kpis";
import { nowIso } from "@/lib/agents/time";
import type { AgentBrief, AgentRunnerResult, BacklogItem, EngineeringTask } from "@/lib/agents/types";

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function opportunityDedupeKey(title: string, owner: string): string {
  return `agent-opportunity:${normalizeTitle(title)}:${String(owner || "engineering").toLowerCase()}`;
}

function ownerLikelyFiles(owner: string): string[] {
  const o = String(owner || "engineering").toLowerCase();
  if (o === "execution") return ["app/api/funnel-health/route.ts", "app/api/funnel-stats/route.ts", "lib/agents/trading-kpis.ts"];
  if (o === "ops") return ["app/api/readiness/route.ts", "app/api/auto-entry/summary/route.ts", "lib/agents/trading-kpis.ts"];
  if (o === "performance") return ["app/api/performance/analytics/route.ts", "app/api/performance/portfolio/route.ts", "lib/agents/trading-kpis.ts"];
  if (o === "pm") return ["app/api/performance/analytics/route.ts", "lib/agents/opportunity-engine.ts", "lib/agents/em-enhancement.ts"];
  return ["lib/agents/opportunity-engine.ts", "lib/agents/em-enhancement.ts", "lib/agents/trading-kpis.ts"];
}

function metricOrNull(kpis: any, key: string): number | null {
  const status = kpis?.metricStatus?.[key];
  if (status === "unavailable") return null;
  const n = Number(kpis?.[key]);
  return Number.isFinite(n) ? n : null;
}

function buildOpportunityTask(now: string, opportunity: PerformanceOpportunity, kpis: any): EngineeringTask {
  const owner = String(opportunity.owner || "engineering").toLowerCase();
  const dedupeKey = opportunityDedupeKey(opportunity.title, owner);
  const likelyFiles = ownerLikelyFiles(owner);

  const beforeMetrics = {
    signalToQualifiedPct: metricOrNull(kpis, "signalToQualifiedPct") ?? 0,
    qualifiedToSeededPct: metricOrNull(kpis, "qualifiedToSeededPct") ?? 0,
    seededToExecutedPct: metricOrNull(kpis, "seededToExecutedPct") ?? 0,
    avgR: metricOrNull(kpis, "avgRealizedR") ?? 0,
    realizedR: metricOrNull(kpis, "actualRImpactRecent") ?? 0,
    staleSignalPct: metricOrNull(kpis, "staleSignalPct") ?? 0,
    executionLatencySec: metricOrNull(kpis, "executionLatencySec") ?? 0,
  };

  const completionRequirements = [
    "Require afterMetrics snapshot for comparison against beforeMetrics.",
    "Target improvement in seededToExecutedPct and reduction in staleSignalPct.",
    "No regression in avgR, realizedR, or execution latency.",
    "Completion quality must be SUCCESS, PARTIAL_SUCCESS, NO_IMPACT, or REGRESSION.",
  ].join(" ");

  return {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: "READY_FOR_EXECUTION",
    title: opportunity.title,
    summary: `${opportunity.estimatedImpactText}. ${opportunity.rationale}`,
    likelyFiles,
    copilotPrompt:
      `Performance opportunity task. Owner=${owner}. Improve metric bottleneck for "${opportunity.title}". ` +
      `Use beforeMetrics baseline and ship measurable improvements without touching broker execution logic.`,
    smokeTestBlock:
      "npm run build\n" +
      "npm run test\n" +
      "GET /api/agents/state\n" +
      "GET /api/agents/brief/latest\n" +
      "GET /api/funnel-health",
    gitBlock: `git add -A && git commit -m "agent: ${opportunity.title}" && git push`,
    remediationAttempted: false,
    remediationStatus: "none",
    successCriteria: completionRequirements,
    patchPlan: {
      mode: "GITHUB_COMMIT",
      targetFiles: likelyFiles,
      proposedChangesSummary: `${opportunity.title} (${opportunity.priority}) — ${opportunity.estimatedImpactText}`,
    },
    validationPlan: {
      buildRequired: true,
      testCommands: ["npm run test"],
      smokeChecks: [
        "GET /api/funnel-health",
        "GET /api/agents/state",
        "GET /api/agents/brief/latest",
      ],
    },
    commitPlan: {
      commitMessage: `agent: ${opportunity.title}`,
      targetBranch: "main",
      pushDirect: true,
    },
    executionStatus: "READY",
    executionError: null,
    expectedRImpact: opportunity.expectedRImpact,
    estimatedImpactDescription: opportunity.estimatedImpactText,
    beforeMetrics,
    completionQuality: undefined,
    notes: [
      `owner_assigned:${owner}`,
      `opportunity_dedupe_key:${dedupeKey}`,
      `opportunity_priority:${opportunity.priority}`,
      `opportunity_status:${opportunity.status}`,
    ],
  };
}

// Context is reserved for future expansion (telemetry, policy signals, etc.).
export async function runEngineeringManagerAgent(_context?: unknown): Promise<AgentRunnerResult> {
  const now = nowIso();
  const currentState = await readAgentState();
  const backlog = await getOpenBacklogItems(200);
  const existingTitles = new Set(backlog.map((item) => item.title.trim().toUpperCase()));

  const tasksToEnsure: Array<{
    title: string;
    summary: string;
    priority: "HIGH" | "MEDIUM";
  }> = [
    {
      title: "Enable GitHub API write access",
      summary: "Allow agents to create branches, commits, and PRs via GitHub API.",
      priority: "HIGH",
    },
    {
      title: "Implement patch executor",
      summary: "Allow system to safely apply code patches generated by agents.",
      priority: "HIGH",
    },
    {
      title: "Add safe commit + deploy pipeline",
      summary: "Create controlled commit, build, and deploy flow with guardrails.",
      priority: "HIGH",
    },
    {
      title: "Add rollback capability",
      summary: "Allow automatic rollback if deploy validation fails.",
      priority: "MEDIUM",
    },
    {
      title: "Add canary deploy validation",
      summary: "Validate new deployments before full rollout.",
      priority: "MEDIUM",
    },
  ];

  const newItems: BacklogItem[] = [];

  for (const task of tasksToEnsure) {
    if (!existingTitles.has(task.title.trim().toUpperCase())) {
      newItems.push({
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        status: "OPEN",
        type: "FEATURE",
        priority: task.priority,
        title: task.title,
        summary: task.summary,
        assignedAgent: "engineering-manager",
      });
    }
  }

  if (newItems.length > 0) {
    // Preserve current open backlog ordering and append newly ensured items.
    await writeBacklog([...backlog, ...newItems]);
  }

  const [priorityFeed, sharedKpis, existingEngineeringTasks] = await Promise.all([
    buildPriorityFeed(5).catch(() => ({ priorities: [] as PerformanceOpportunity[], hasIncidents: false })),
    getSharedTradingKpis().catch(() => null),
    listEngineeringTasks(200),
  ]);

  const openOpportunities = (priorityFeed.priorities || []).filter((p) => p.status === "OPEN");
  const topOpportunity = openOpportunities[0] ?? null;
  let opportunityTasksCreated = 0;
  let opportunityTasksUpdated = 0;

  for (const opp of openOpportunities) {
    const dedupeKey = opportunityDedupeKey(opp.title, opp.owner);
    const existing = existingEngineeringTasks.find((task) => {
      const notes = Array.isArray(task.notes) ? task.notes : [];
      return (
        task.status !== "DONE" &&
        task.status !== "FAILED" &&
        (notes.some((n) => String(n).includes(`opportunity_dedupe_key:${dedupeKey}`)) || normalizeTitle(task.title) === normalizeTitle(opp.title))
      );
    });

    const taskDraft = buildOpportunityTask(now, opp, sharedKpis);
    const upserted = await upsertEngineeringTask(taskDraft);
    if (upserted.created) {
      opportunityTasksCreated += 1;
      existingEngineeringTasks.unshift(upserted.task);
      continue;
    }

    opportunityTasksUpdated += 1;
    await updateEngineeringTaskById(upserted.task.id, {
      status: "READY_FOR_EXECUTION",
      executionStatus: "READY",
      executionError: null,
      likelyFiles: taskDraft.likelyFiles,
      patchPlan: taskDraft.patchPlan,
      validationPlan: taskDraft.validationPlan,
      commitPlan: taskDraft.commitPlan,
      expectedRImpact: taskDraft.expectedRImpact,
      estimatedImpactDescription: taskDraft.estimatedImpactDescription,
      beforeMetrics: taskDraft.beforeMetrics,
      successCriteria: taskDraft.successCriteria,
      notes: [...(upserted.task.notes ?? []), `Updated existing opportunity task (${dedupeKey})`, `expected_r_impact:${opp.expectedRImpact}`].slice(-20),
    });
  }

  const engineeringTasks = await listEngineeringTasks(200);
  let newlyReadyCount = 0;
  let newlyBlockedCount = 0;
  let latestExecutionReadyTitle: string | null = null;
  let latestExecutionStatus: "READY_FOR_EXECUTION" | "READY_FOR_PUSH" | "BLOCKED" | null = null;

  for (const task of engineeringTasks) {
    if (task.status !== "OPEN" && task.status !== "IN_PROGRESS") continue;

    const approval = approveExecution(task);
    if (!approval.ok) {
      if (task.executionStatus !== "BLOCKED" || task.executionError !== approval.reason) {
        await updateEngineeringTaskById(task.id, {
          status: "BLOCKED",
          executionStatus: "BLOCKED",
          executionError: approval.reason,
          notes: [...(task.notes ?? []), `Execution blocked: ${approval.reason}`].slice(-20),
        });
      }
      newlyBlockedCount += 1;
      if (!latestExecutionStatus) {
        latestExecutionStatus = "BLOCKED";
        latestExecutionReadyTitle = task.title;
      }
      continue;
    }

    const prepared = prepareExecutionPlan(task);
    const needsUpdate =
      task.executionStatus !== prepared.executionStatus ||
      task.executionError != null ||
      !task.patchPlan ||
      !task.validationPlan ||
      !task.commitPlan;

    if (needsUpdate) {
      await updateEngineeringTaskById(task.id, {
        status: prepared.nextTaskStatus,
        patchPlan: prepared.patchPlan,
        validationPlan: prepared.validationPlan,
        commitPlan: prepared.commitPlan,
        executionStatus: prepared.executionStatus,
        executionError: null,
        notes: [...(task.notes ?? []), `Execution readiness prepared: ${prepared.nextTaskStatus}`].slice(-20),
      });
    }

    newlyReadyCount += 1;
    if (!latestExecutionStatus) {
      latestExecutionStatus = prepared.nextTaskStatus;
      latestExecutionReadyTitle = task.title;
    }
  }

  const refreshedBacklog = await listBacklogItems(200);
  const openBacklogCount = refreshedBacklog.filter((item) => item.status === "OPEN" || item.status === "READY").length;
  const inProgressBacklogCount = refreshedBacklog.filter((item) => item.status === "IN_PROGRESS").length;
  const nextBacklogTitles = refreshedBacklog
    .filter((item) => item.status === "OPEN" || item.status === "READY")
    .slice(0, 3)
    .map((item) => item.title);

  const brief: AgentBrief = {
    id: crypto.randomUUID(),
    agent: "engineering-manager",
    briefType: "STATUS",
    createdAt: now,
    title:
      opportunityTasksCreated + opportunityTasksUpdated > 0
        ? "Engineering manager converted opportunities to execution tasks"
        : newItems.length > 0
          ? "Engineering manager seeded backlog"
          : "Engineering manager backlog unchanged",
    summary:
      opportunityTasksCreated + opportunityTasksUpdated > 0
        ? `Created ${opportunityTasksCreated} and updated ${opportunityTasksUpdated} opportunity task(s). Top opportunity: ${topOpportunity?.title ?? "n/a"} owner=${topOpportunity?.owner ?? "n/a"} expectedRImpact=${topOpportunity?.expectedRImpact ?? "unknown"}.`
        : newItems.length > 0
          ? `Ensured ${tasksToEnsure.length} strategic backlog items and created ${newItems.length} missing item${newItems.length === 1 ? "" : "s"}.`
          : `Strategic backlog already satisfied across ${tasksToEnsure.length} managed items.`,
    details: {
      created: newItems.length,
      ensured: tasksToEnsure.length,
      opportunityTasksCreated,
      opportunityTasksUpdated,
      topOpportunityTitle: topOpportunity?.title ?? null,
      topOpportunityOwner: topOpportunity?.owner ?? null,
      topOpportunityExpectedRImpact: topOpportunity?.expectedRImpact ?? null,
      openExecutionReadyCount: newlyReadyCount,
      blockedTaskCount: newlyBlockedCount,
      latestExecutionTaskTitle: latestExecutionReadyTitle,
      latestExecutionStatus,
      openBacklogCount,
      inProgressBacklogCount,
      nextBacklogTitles,
    },
  };

  await appendAgentBrief(brief);

  const savedState = await writeAgentState({
    ...currentState,
    asOf: now,
    latestBriefId: brief.id,
    openExecutionReadyCount: newlyReadyCount,
    blockedTaskCount: newlyBlockedCount,
    openBacklogCount,
    inProgressBacklogCount,
    nextBacklogTitles,
    latestExecutionTaskTitle: latestExecutionReadyTitle,
    latestExecutionStatus,
    updatedBy: "engineering-manager",
  });

  const action = await appendAgentAction({
    id: crypto.randomUUID(),
    createdAt: now,
    agent: "engineering-manager",
    actionType: "BACKLOG_ENSURE",
    status: "APPLIED",
    summary:
      opportunityTasksCreated + opportunityTasksUpdated > 0
        ? `Opportunity loop: created ${opportunityTasksCreated}, updated ${opportunityTasksUpdated}; selected "${topOpportunity?.title ?? "n/a"}" owner=${topOpportunity?.owner ?? "n/a"} expectedR=${topOpportunity?.expectedRImpact ?? "unknown"}.`
        : newItems.length > 0
          ? `Created ${newItems.length} missing strategic backlog item${newItems.length === 1 ? "" : "s"}.`
          : "Existing task already covers top opportunity.",
    metadata: {
      created: newItems.length,
      ensured: tasksToEnsure.length,
      opportunityTasksCreated,
      opportunityTasksUpdated,
      topOpportunityTitle: topOpportunity?.title ?? null,
      topOpportunityOwner: topOpportunity?.owner ?? null,
      topOpportunityExpectedRImpact: topOpportunity?.expectedRImpact ?? null,
      executionReadyCount: newlyReadyCount,
      blockedTaskCount: newlyBlockedCount,
      latestExecutionTaskTitle: latestExecutionReadyTitle,
      latestExecutionStatus,
      titles: tasksToEnsure.map((task) => task.title),
    },
  });

  return {
    agent: "engineering-manager",
    state: savedState,
    briefId: brief.id,
    actionId: action.id,
    summary: brief.summary,
  };
}
