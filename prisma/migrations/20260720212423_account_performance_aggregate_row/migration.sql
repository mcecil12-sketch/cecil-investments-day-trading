-- DropForeignKey
ALTER TABLE "AccountPerformance" DROP CONSTRAINT "AccountPerformance_accountId_fkey";

-- AlterTable
ALTER TABLE "AccountPerformance" ADD COLUMN     "isAggregate" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "accountId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "AccountPerformance_isAggregate_period_idx" ON "AccountPerformance"("isAggregate", "period");

-- AddForeignKey
ALTER TABLE "AccountPerformance" ADD CONSTRAINT "AccountPerformance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
