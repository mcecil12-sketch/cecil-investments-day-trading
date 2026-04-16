import { NextResponse } from "next/server";
import { readTodayFunnel } from "@/lib/funnelRedis";

export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

/**
 * Helper to safely extract numeric value with 0 default
 */
function num(val: unknown): number {
  return typeof val === "number" && Number.isFinite(val) ? val : 0;
}

export async function GET() {
  const today = await readTodayFunnel();
  
  // Phase 3: Build summary views for pre-post gating and seed attribution
  const phase3 = {
    scanner: {
      prePostGatePassLong: num(today.scanPrePostGatePassLong),
      prePostGatePassShort: num(today.scanPrePostGatePassShort),
      prePostGateSkipLong: num(today.scanPrePostGateSkipLong),
      prePostGateSkipShort: num(today.scanPrePostGateSkipShort),
      candidatesLong: num(today.scanCandidatesLong),
      candidatesShort: num(today.scanCandidatesShort),
      // Derived
      totalPassed: num(today.scanPrePostGatePassLong) + num(today.scanPrePostGatePassShort),
      totalSkipped: num(today.scanPrePostGateSkipLong) + num(today.scanPrePostGateSkipShort),
    },
    seed: {
      fromQualifiedLong: num(today.seedFromQualifiedLong),
      fromQualifiedShort: num(today.seedFromQualifiedShort),
      totalCandidates: num(today.seedTotalCandidates),
      createdCount: num(today.seedCreatedCount),
      // Phase 3c: Deduplication visibility
      uniqueCandidates: num(today.seedUniqueCandidates),
      duplicatesCollapsed: num(today.seedDuplicatesCollapsed),
      // Skip reasons
      skippedNotQualified: num(today.seedSkippedNotQualified),
      skippedOverlayGrade: num(today.seedSkippedOverlayGrade),
      skippedMissingSymbol: num(today.seedSkippedMissingSymbol),
      skippedAlreadyHasTrade: num(today.seedSkippedAlreadyHasTrade),
      skippedDuplicate: num(today.seedSkippedDuplicate),
      skippedLimitReached: num(today.seedSkippedLimitReached),
      skippedBelowMinScore: num(today.seedSkippedBelowMinScore),
      skippedMissingDirection: num(today.seedSkippedMissingDirection),
      skippedMissingPrices: num(today.seedSkippedMissingPrices),
      skippedTierDisabled: num(today.seedSkippedTierDisabled),
      skippedOther: num(today.seedSkippedOther),
      // Derived
      totalSeeded: num(today.seedFromQualifiedLong) + num(today.seedFromQualifiedShort),
      totalSkipped: num(today.seedSkippedNotQualified) + num(today.seedSkippedOverlayGrade) +
                    num(today.seedSkippedMissingSymbol) + num(today.seedSkippedAlreadyHasTrade) +
                    num(today.seedSkippedDuplicate) + num(today.seedSkippedLimitReached) +
                    num(today.seedSkippedBelowMinScore) + num(today.seedSkippedMissingDirection) +
                    num(today.seedSkippedMissingPrices) + num(today.seedSkippedTierDisabled) +
                    num(today.seedSkippedOther),
    },
    // Phase 3c: Short quality tracking
    shortQuality: {
      qualified: num(today.shortQualified),
      seeded: num(today.shortSeeded),
      skippedWeakStructure: num(today.shortSkippedWeakStructure),
    },
    execute: {
      fromSeededLong: num(today.executeFromSeededLong),
      fromSeededShort: num(today.executeFromSeededShort),
      skippedPriceDrift: num(today.executeSkippedPriceDrift),
      skippedLiquidity: num(today.executeSkippedLiquidity),
      skippedBracketInvalid: num(today.executeSkippedBracketInvalid),
      skippedOther: num(today.executeSkippedOther),
      // Phase 3c: Invalid trade cleanup visibility
      invalidMarked: num(today.executeInvalidMarked),
      staleArchived: num(today.executeStaleArchived),
      duplicatesArchived: num(today.executeDuplicatesArchived),
      // Derived
      totalExecuted: num(today.executeFromSeededLong) + num(today.executeFromSeededShort),
      totalSkipped: num(today.executeSkippedPriceDrift) + num(today.executeSkippedLiquidity) +
                    num(today.executeSkippedBracketInvalid) + num(today.executeSkippedOther),
      totalCleaned: num(today.executeInvalidMarked) + num(today.executeStaleArchived) + 
                    num(today.executeDuplicatesArchived),
    },
    // End-to-end conversion summary
    conversion: {
      scannedLong: num(today.scanPrePostGatePassLong),
      scannedShort: num(today.scanPrePostGatePassShort),
      seededLong: num(today.seedFromQualifiedLong),
      seededShort: num(today.seedFromQualifiedShort),
      executedLong: num(today.executeFromSeededLong),
      executedShort: num(today.executeFromSeededShort),
    },
  };
  
  return NextResponse.json(
    {
      today,
      phase3,
      timestamp: new Date().toISOString(),
    },
    { headers: CACHE_HEADERS }
  );
}
