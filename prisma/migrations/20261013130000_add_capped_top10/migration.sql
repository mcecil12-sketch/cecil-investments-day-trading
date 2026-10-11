-- AlterTable
ALTER TABLE "CandidateRecommendationLog" ADD COLUMN     "cappedRank" INTEGER,
ADD COLUMN     "inCappedTop10" BOOLEAN;
