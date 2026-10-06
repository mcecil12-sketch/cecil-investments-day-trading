-- AlterTable
ALTER TABLE "CandidateRecommendationLog" ADD COLUMN     "insiderNetSoldUsd30d" DOUBLE PRECISION,
ADD COLUMN     "insiderSaleCount30d" INTEGER,
ADD COLUMN     "insiderSellers30d" INTEGER,
ADD COLUMN     "insiderHas10b5_1" BOOLEAN;
