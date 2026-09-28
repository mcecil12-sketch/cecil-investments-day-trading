-- AlterEnum
ALTER TYPE "AgentType" ADD VALUE 'SENTIMENT_REFRESH';
ALTER TYPE "AgentType" ADD VALUE 'PERFORMANCE_ANALYST';

-- AlterTable
ALTER TABLE "CandidateRecommendationLog" ADD COLUMN     "sentimentScore" INTEGER,
ADD COLUMN     "sentimentCoverage" TEXT;

-- AlterTable
ALTER TABLE "WeeklyBrief" ADD COLUMN     "performanceAnalysis" JSONB;

-- CreateTable
CREATE TABLE "SentimentFetchState" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "hasCoverage" BOOLEAN NOT NULL DEFAULT false,
    "score" INTEGER,
    "articleCount" INTEGER,
    "lastFetchedAt" TIMESTAMP(3),
    "lastAttemptedAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SentimentFetchState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SentimentFetchState_symbol_key" ON "SentimentFetchState"("symbol");

-- CreateIndex
CREATE INDEX "SentimentFetchState_lastFetchedAt_idx" ON "SentimentFetchState"("lastFetchedAt");
