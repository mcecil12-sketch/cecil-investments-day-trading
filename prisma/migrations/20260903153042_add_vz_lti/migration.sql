-- AlterEnum
ALTER TYPE "AccountType" ADD VALUE 'VZ_LTI';

-- CreateTable
CREATE TABLE "VzLtiTranche" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "cohortLabel" TEXT NOT NULL,
    "grantYear" INTEGER NOT NULL,
    "vestDate" TIMESTAMP(3) NOT NULL,
    "shares" DOUBLE PRECISION NOT NULL,
    "currentValue" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "VzLtiTranche_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VzLtiTranche_accountId_vestDate_idx" ON "VzLtiTranche"("accountId", "vestDate");

-- CreateIndex
CREATE UNIQUE INDEX "VzLtiTranche_importBatchId_cohortLabel_vestDate_key" ON "VzLtiTranche"("importBatchId", "cohortLabel", "vestDate");

-- AddForeignKey
ALTER TABLE "VzLtiTranche" ADD CONSTRAINT "VzLtiTranche_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VzLtiTranche" ADD CONSTRAINT "VzLtiTranche_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

