-- AlterEnum
ALTER TYPE "AgentType" ADD VALUE 'MONTHLY_SCAN';

-- CreateEnum
CREATE TYPE "RecommendationGroup" AS ENUM ('GROUP_1', 'GROUP_3');

-- AlterTable
ALTER TABLE "CandidateRecommendationLog" ADD COLUMN     "group" "RecommendationGroup" NOT NULL DEFAULT 'GROUP_1',
ADD COLUMN     "rank" INTEGER,
ADD COLUMN     "earningsSurpriseCoverage" TEXT;

-- CreateIndex
CREATE INDEX "CandidateRecommendationLog_group_recommendedAt_idx" ON "CandidateRecommendationLog"("group", "recommendedAt");

-- CreateTable
CREATE TABLE "MonthlyScanEarningsState" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "lastScoredFiscalDateEnding" TIMESTAMP(3),
    "lastEarningsSurpriseScore" INTEGER,
    "lastEarningsSurpriseCoverage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyScanEarningsState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyScanEarningsState_symbol_key" ON "MonthlyScanEarningsState"("symbol");
