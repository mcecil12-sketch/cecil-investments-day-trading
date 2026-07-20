-- AlterEnum
ALTER TYPE "AgentType" ADD VALUE 'CANDIDATE_SCANNER';

-- CreateTable
CREATE TABLE "RecommendationOutcome" (
    "id" TEXT NOT NULL,
    "weeklyBriefId" TEXT NOT NULL,
    "actionItemIndex" INTEGER NOT NULL,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "executedDate" TIMESTAMP(3),
    "outcome30d" DOUBLE PRECISION,
    "outcome90d" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendationOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationOutcome_weeklyBriefId_actionItemIndex_key" ON "RecommendationOutcome"("weeklyBriefId", "actionItemIndex");

-- AddForeignKey
ALTER TABLE "RecommendationOutcome" ADD CONSTRAINT "RecommendationOutcome_weeklyBriefId_fkey" FOREIGN KEY ("weeklyBriefId") REFERENCES "WeeklyBrief"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
