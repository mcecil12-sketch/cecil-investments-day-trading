-- AlterTable
ALTER TABLE "CandidateRecommendationLog" ADD COLUMN     "scanClose" DOUBLE PRECISION,
ADD COLUMN     "priceDate" TIMESTAMP(3),
ADD COLUMN     "marketCap" DOUBLE PRECISION,
ADD COLUMN     "marketCapSource" TEXT,
ADD COLUMN     "insiderNetSoldPctOfMarketCap" DOUBLE PRECISION;
