-- CreateTable
CREATE TABLE "BenchmarkPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "close" REAL NOT NULL
);

-- CreateTable
CREATE TABLE "BenchmarkResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "importBatchId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "accountId" TEXT,
    "period" TEXT NOT NULL,
    "asOfDate" DATETIME NOT NULL,
    "requestedStartDate" DATETIME NOT NULL,
    "actualStartDate" DATETIME,
    "startValue" REAL,
    "endValue" REAL NOT NULL,
    "portfolioReturn" REAL,
    "sp500Return" REAL,
    "alpha" REAL,
    "insufficientHistory" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BenchmarkResult_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BenchmarkResult_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "BenchmarkPrice_date_key" ON "BenchmarkPrice"("date");

-- CreateIndex
CREATE INDEX "BenchmarkResult_scope_period_asOfDate_idx" ON "BenchmarkResult"("scope", "period", "asOfDate");

-- CreateIndex
CREATE INDEX "BenchmarkResult_accountId_period_idx" ON "BenchmarkResult"("accountId", "period");
