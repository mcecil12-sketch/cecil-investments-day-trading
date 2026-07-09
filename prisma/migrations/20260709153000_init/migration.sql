-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('FIDELITY_TAXABLE', 'VZ_SAVINGS_401K', 'VZ_LEGACY_401K', 'VZ_EDP');

-- CreateEnum
CREATE TYPE "InstrumentType" AS ENUM ('STOCK', 'FUND', 'CASH');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING', 'COMPLETE', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "BenchmarkScope" AS ENUM ('ACCOUNT', 'AGGREGATE_TOTAL', 'AGGREGATE_ACTIONABLE');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "institution" TEXT NOT NULL,
    "externalId" TEXT,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Instrument" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT,
    "type" "InstrumentType" NOT NULL DEFAULT 'STOCK',
    "expenseRatio" DOUBLE PRECISION,
    "category" TEXT,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holding" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "lastPrice" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION NOT NULL,
    "costBasisTotal" DOUBLE PRECISION,
    "averageCostBasis" DOUBLE PRECISION,
    "percentOfAccount" DOUBLE PRECISION,

    CONSTRAINT "Holding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkPrice" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "BenchmarkPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkResult" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "scope" "BenchmarkScope" NOT NULL,
    "accountId" TEXT,
    "period" TEXT NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "requestedStartDate" TIMESTAMP(3) NOT NULL,
    "actualStartDate" TIMESTAMP(3),
    "startValue" DOUBLE PRECISION,
    "endValue" DOUBLE PRECISION,
    "portfolioReturn" DOUBLE PRECISION,
    "sp500Return" DOUBLE PRECISION,
    "alpha" DOUBLE PRECISION,
    "insufficientHistory" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BenchmarkResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_externalId_key" ON "Account"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_symbol_key" ON "Instrument"("symbol");

-- CreateIndex
CREATE INDEX "ImportBatch_accountId_asOfDate_idx" ON "ImportBatch"("accountId", "asOfDate");

-- CreateIndex
CREATE INDEX "Holding_accountId_asOfDate_idx" ON "Holding"("accountId", "asOfDate");

-- CreateIndex
CREATE INDEX "Holding_instrumentId_idx" ON "Holding"("instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "BenchmarkPrice_date_key" ON "BenchmarkPrice"("date");

-- CreateIndex
CREATE INDEX "BenchmarkResult_scope_period_asOfDate_idx" ON "BenchmarkResult"("scope", "period", "asOfDate");

-- CreateIndex
CREATE INDEX "BenchmarkResult_accountId_period_idx" ON "BenchmarkResult"("accountId", "period");

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holding" ADD CONSTRAINT "Holding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holding" ADD CONSTRAINT "Holding_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holding" ADD CONSTRAINT "Holding_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkResult" ADD CONSTRAINT "BenchmarkResult_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkResult" ADD CONSTRAINT "BenchmarkResult_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

