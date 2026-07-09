-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BenchmarkResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "importBatchId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "accountId" TEXT,
    "period" TEXT NOT NULL,
    "asOfDate" DATETIME NOT NULL,
    "requestedStartDate" DATETIME NOT NULL,
    "actualStartDate" DATETIME,
    "startValue" REAL,
    "endValue" REAL,
    "portfolioReturn" REAL,
    "sp500Return" REAL,
    "alpha" REAL,
    "insufficientHistory" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BenchmarkResult_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BenchmarkResult_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BenchmarkResult" ("accountId", "actualStartDate", "alpha", "asOfDate", "createdAt", "endValue", "id", "importBatchId", "insufficientHistory", "period", "portfolioReturn", "requestedStartDate", "scope", "sp500Return", "startValue") SELECT "accountId", "actualStartDate", "alpha", "asOfDate", "createdAt", "endValue", "id", "importBatchId", "insufficientHistory", "period", "portfolioReturn", "requestedStartDate", "scope", "sp500Return", "startValue" FROM "BenchmarkResult";
DROP TABLE "BenchmarkResult";
ALTER TABLE "new_BenchmarkResult" RENAME TO "BenchmarkResult";
CREATE INDEX "BenchmarkResult_scope_period_asOfDate_idx" ON "BenchmarkResult"("scope", "period", "asOfDate");
CREATE INDEX "BenchmarkResult_accountId_period_idx" ON "BenchmarkResult"("accountId", "period");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
