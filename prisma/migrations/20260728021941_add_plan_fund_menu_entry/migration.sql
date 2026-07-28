-- CreateTable
CREATE TABLE "PlanFundMenuEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fundName" TEXT NOT NULL,
    "assetClass" TEXT,
    "ticker" TEXT,
    "oneYear" DOUBLE PRECISION,
    "threeYear" DOUBLE PRECISION,
    "fiveYear" DOUBLE PRECISION,
    "tenYear" DOUBLE PRECISION,
    "inceptionDate" TIMESTAMP(3),
    "isHeld" BOOLEAN NOT NULL DEFAULT false,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanFundMenuEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanFundMenuEntry_accountId_idx" ON "PlanFundMenuEntry"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanFundMenuEntry_accountId_fundName_key" ON "PlanFundMenuEntry"("accountId", "fundName");

-- AddForeignKey
ALTER TABLE "PlanFundMenuEntry" ADD CONSTRAINT "PlanFundMenuEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanFundMenuEntry" ADD CONSTRAINT "PlanFundMenuEntry_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
