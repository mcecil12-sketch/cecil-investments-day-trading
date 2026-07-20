-- CreateTable
CREATE TABLE "AccountPerformance" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "returnPct" DOUBLE PRECISION NOT NULL,
    "sp500ReturnPct" DOUBLE PRECISION,
    "alpha" DOUBLE PRECISION,
    "startDate" TIMESTAMP(3),
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountPerformance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountPerformance_accountId_period_idx" ON "AccountPerformance"("accountId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "AccountPerformance_accountId_period_asOfDate_key" ON "AccountPerformance"("accountId", "period", "asOfDate");

-- AddForeignKey
ALTER TABLE "AccountPerformance" ADD CONSTRAINT "AccountPerformance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
