-- CreateTable
CREATE TABLE "EarningsFetchState" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "hasHistory" BOOLEAN NOT NULL DEFAULT false,
    "lastFetchedAt" TIMESTAMP(3),
    "lastAttemptedAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarningsFetchState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarningsHistory" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "fiscalDateEnding" TIMESTAMP(3) NOT NULL,
    "reportedDate" TIMESTAMP(3),
    "reportedEPS" DOUBLE PRECISION,
    "estimatedEPS" DOUBLE PRECISION,
    "surprise" DOUBLE PRECISION,
    "surprisePercentage" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarningsHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EarningsFetchState_symbol_key" ON "EarningsFetchState"("symbol");

-- CreateIndex
CREATE INDEX "EarningsFetchState_lastFetchedAt_idx" ON "EarningsFetchState"("lastFetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EarningsHistory_symbol_fiscalDateEnding_key" ON "EarningsHistory"("symbol", "fiscalDateEnding");

-- CreateIndex
CREATE INDEX "EarningsHistory_symbol_idx" ON "EarningsHistory"("symbol");
