-- AlterEnum
ALTER TYPE "AgentType" ADD VALUE 'EARNINGS_ESTIMATES_REFRESH';

-- CreateTable
CREATE TABLE "EarningsEstimateSnapshot" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "epsEstimateAverageCurrent" DOUBLE PRECISION,
    "epsEstimateAverage7DaysAgo" DOUBLE PRECISION,
    "epsEstimateAverage30DaysAgo" DOUBLE PRECISION,
    "epsEstimateAverage60DaysAgo" DOUBLE PRECISION,
    "epsEstimateAverage90DaysAgo" DOUBLE PRECISION,
    "revisionUpTrailing7Days" INTEGER,
    "revisionDownTrailing7Days" INTEGER,
    "revisionUpTrailing30Days" INTEGER,
    "revisionDownTrailing30Days" INTEGER,
    "hasEstimates" BOOLEAN NOT NULL DEFAULT false,
    "lastFetchedAt" TIMESTAMP(3),
    "lastAttemptedAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarningsEstimateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EarningsEstimateSnapshot_symbol_key" ON "EarningsEstimateSnapshot"("symbol");

-- CreateIndex
CREATE INDEX "EarningsEstimateSnapshot_lastFetchedAt_idx" ON "EarningsEstimateSnapshot"("lastFetchedAt");
