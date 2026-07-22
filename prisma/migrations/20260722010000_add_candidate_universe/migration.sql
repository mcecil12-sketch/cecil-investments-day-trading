-- AlterEnum
ALTER TYPE "AgentType" ADD VALUE 'UNIVERSE_REFRESH';

-- CreateTable
CREATE TABLE "CandidateUniverse" (
    "id" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "sectorEtf" TEXT NOT NULL,
    "symbols" JSONB NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateUniverse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CandidateUniverse_sector_key" ON "CandidateUniverse"("sector");

-- Seed data: top-30-by-weight holdings for the sectors migrated to the
-- SSGA-derived refresh (lib/agents/candidateUniverse.ts), pulled live from
-- ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-{xle,xlv,xlk}.xlsx
-- (fund holdings dated "As of 20-Jul-2026") to seed this table with real
-- data instead of the hardcoded lists it replaces. Energy has only 21
-- holdings after excluding SSGA's cash-sweep and futures rows, so it
-- contributes its full list rather than 30. The next scheduled run of
-- refresh-candidate-universe overwrites these rows.
INSERT INTO "CandidateUniverse" ("id", "sector", "sectorEtf", "symbols", "asOf", "updatedAt") VALUES
  ('seed-candidate-universe-energy', 'Energy', 'XLE', '["XOM","CVX","COP","MPC","PSX","VLO","EOG","SLB","WMB","KMI","TRGP","OKE","BKR","DVN","OXY","FANG","EQT","HAL","TPL","EXE","APA"]'::jsonb, now(), now()),
  ('seed-candidate-universe-healthcare', 'Healthcare', 'XLV', '["LLY","JNJ","ABBV","UNH","MRK","AMGN","TMO","ABT","GILD","PFE","CVS","DHR","ISRG","BMY","VRTX","SYK","MDT","MCK","ELV","CI","REGN","BSX","COR","HCA","CAH","EW","HUM","IDXX","BDX","A"]'::jsonb, now(), now()),
  ('seed-candidate-universe-technology', 'Technology', 'XLK', '["NVDA","AAPL","MSFT","AVGO","AMD","MU","INTC","CSCO","AMAT","LRCX","PLTR","PANW","KLAC","TXN","SNDK","ORCL","CRWD","IBM","APH","ADI","STX","QCOM","ANET","MRVL","WDC","CRM","GLW","APP","DELL","NOW"]'::jsonb, now(), now());
