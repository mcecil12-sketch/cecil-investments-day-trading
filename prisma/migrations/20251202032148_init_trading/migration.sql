-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "entryPrice" REAL NOT NULL,
    "stopPrice" REAL,
    "targetPrice" REAL,
    "openedAt" DATETIME NOT NULL,
    "closedAt" DATETIME,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "realizedPnL" REAL,
    "initialRiskPerShare" REAL,
    "initialDollarRisk" REAL,
    "maxRReached" REAL,
    "management" JSONB
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "stopPrice" REAL,
    "targetPrice" REAL,
    "reasoning" TEXT,
    "source" TEXT,
    "createdAt" DATETIME NOT NULL
);
