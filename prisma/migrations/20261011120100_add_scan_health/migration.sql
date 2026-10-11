-- CreateEnum
CREATE TYPE "ScanHealthStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'FAILED');

-- CreateTable
CREATE TABLE "ScanHealth" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "ScanHealthStatus" NOT NULL,
    "reasons" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "agentRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanHealth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScanHealth_kind_createdAt_idx" ON "ScanHealth"("kind", "createdAt");
