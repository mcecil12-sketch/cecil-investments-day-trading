-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('RELATIVE_STRENGTH', 'SECTOR_ROTATION', 'RISK_MANAGER');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "agentType" "AgentType" NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "output" JSONB,
    "errorMessage" TEXT,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionItem" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "expectedImpact" TEXT,
    "accountId" TEXT,
    "weeklyBriefId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyBrief" (
    "id" TEXT NOT NULL,
    "weekOf" TIMESTAMP(3) NOT NULL,
    "cioSummary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyBrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentRun_agentType_startedAt_idx" ON "AgentRun"("agentType", "startedAt");

-- CreateIndex
CREATE INDEX "ActionItem_agentRunId_idx" ON "ActionItem"("agentRunId");

-- CreateIndex
CREATE INDEX "ActionItem_weeklyBriefId_idx" ON "ActionItem"("weeklyBriefId");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyBrief_weekOf_key" ON "WeeklyBrief"("weekOf");

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_weeklyBriefId_fkey" FOREIGN KEY ("weeklyBriefId") REFERENCES "WeeklyBrief"("id") ON DELETE SET NULL ON UPDATE CASCADE;
