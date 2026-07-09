#!/usr/bin/env node
/**
 * Tick-size compliance self-test
 * Validates quantizePrice, normalizeStopPrice, normalizeLimitPrice
 * Run with: npx ts-node scripts/tickSizeSelfTest.ts
 */

import {
  quantizePrice,
  normalizeStopPrice,
  normalizeLimitPrice,
  tickForEquityPrice,
} from "../lib/tickSize";

interface TestResult {
  name: string;
  pass: boolean;
  expected: any;
  actual: any;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true, expected: "✓", actual: "✓" });
    console.log(`✓ ${name}`);
  } catch (err: any) {
    results.push({
      name,
      pass: false,
      expected: err?.expected,
      actual: err?.actual,
      error: err?.message,
    });
    console.log(`✗ ${name}: ${err?.message}`);
  }
}

function assertEqual(actual: any, expected: any, msg?: string) {
  if (actual !== expected) {
    throw {
      message: msg || `Expected ${expected}, got ${actual}`,
      expected,
      actual,
    };
  }
}

function assertCloseTo(actual: number, expected: number, tolerance = 0.00001) {
  if (Math.abs(actual - expected) > tolerance) {
    throw {
      message: `Expected ~${expected}, got ${actual} (diff: ${Math.abs(actual - expected)})`,
      expected,
      actual,
    };
  }
}

// Tests for quantizePrice
test("quantizePrice: basic rounding to penny (24.05)", () => {
  const result = quantizePrice(24.05, 0.01, "round");
  assertEqual(result, 24.05);
});

test("quantizePrice: sub-penny up (24.0591 -> 24.06 with ceil)", () => {
  const result = quantizePrice(24.0591, 0.01, "ceil");
  assertEqual(result, 24.06);
});

test("quantizePrice: sub-penny down (24.0591 -> 24.05 with floor)", () => {
  const result = quantizePrice(24.0591, 0.01, "floor");
  assertEqual(result, 24.05);
});

test("quantizePrice: sub-penny down (24.049999 -> 24.05 with round)", () => {
  const result = quantizePrice(24.049999, 0.01, "round");
  assertEqual(result, 24.05);
});

test("quantizePrice: sub-penny up (24.055 -> 24.06 with round)", () => {
  const result = quantizePrice(24.055, 0.01, "round");
  assertEqual(result, 24.06);
});

test("quantizePrice: sub-penny down (24.054 -> 24.05 with round)", () => {
  const result = quantizePrice(24.054, 0.01, "round");
  assertEqual(result, 24.05);
});

test("quantizePrice: penny stock (0.5001 -> 0.50 with floor)", () => {
  const result = quantizePrice(0.5001, 0.0001, "floor");
  assertEqual(result, 0.5);
});

// Tests for normalizeStopPrice
test("normalizeStopPrice: LONG stop below entry (valid)", () => {
  const result = normalizeStopPrice({
    side: "LONG",
    entryPrice: 24.05,
    stopPrice: 24.04,
  });
  assertEqual(result.ok, true);
  assertEqual(result.stop, 24.04);
});

test("normalizeStopPrice: LONG stop above entry (invalid)", () => {
  const result = normalizeStopPrice({
    side: "LONG",
    entryPrice: 24.05,
    stopPrice: 24.06,
  });
  assertEqual(result.ok, false);
});

test("normalizeStopPrice: SHORT stop above entry (valid)", () => {
  const result = normalizeStopPrice({
    side: "SHORT",
    entryPrice: 24.05,
    stopPrice: 24.06,
  });
  assertEqual(result.ok, true);
  assertEqual(result.stop, 24.06);
});

test("normalizeStopPrice: SHORT stop below entry (invalid)", () => {
  const result = normalizeStopPrice({
    side: "SHORT",
    entryPrice: 24.05,
    stopPrice: 24.04,
  });
  assertEqual(result.ok, false);
});

test("normalizeStopPrice: LONG with sub-penny (24.0491 -> 24.04 floor)", () => {
  const result = normalizeStopPrice({
    side: "LONG",
    entryPrice: 24.05,
    stopPrice: 24.0491,
  });
  assertEqual(result.ok, true);
  assertEqual(result.stop, 24.04);
});

test("normalizeStopPrice: SHORT with sub-penny (24.0591 -> 24.06 ceil)", () => {
  const result = normalizeStopPrice({
    side: "SHORT",
    entryPrice: 24.05,
    stopPrice: 24.0591,
  });
  assertEqual(result.ok, true);
  assertEqual(result.stop, 24.06);
});

// Tests for normalizeLimitPrice
test("normalizeLimitPrice: basic rounding (24.0591 -> 24.06)", () => {
  const result = normalizeLimitPrice({ price: 24.0591 });
  assertEqual(result, 24.06);
});

test("normalizeLimitPrice: already aligned (24.05 -> 24.05)", () => {
  const result = normalizeLimitPrice({ price: 24.05 });
  assertEqual(result, 24.05);
});

// Tests for tickForEquityPrice
test("tickForEquityPrice: >= 1.00 returns 0.01", () => {
  const result = tickForEquityPrice(24.05);
  assertEqual(result, 0.01);
});

test("tickForEquityPrice: < 1.00 returns 0.0001", () => {
  const result = tickForEquityPrice(0.50);
  assertEqual(result, 0.0001);
});

test("tickForEquityPrice: exactly 1.00 returns 0.01", () => {
  const result = tickForEquityPrice(1.0);
  assertEqual(result, 0.01);
});

// Integration tests
test("Integration: LONG stop-loss with floating point artifacts", () => {
  // Simulate: entry = 24.05, risk = $0.05 from division
  const entryPrice = 24.05;
  const riskDollars = 0.05;
  const shares = 100;
  const computedStop = entryPrice - riskDollars / shares; // 24.05 - 0.0005 = 24.0495
  
  const result = normalizeStopPrice({
    side: "LONG",
    entryPrice,
    stopPrice: computedStop,
  });
  
  assertEqual(result.ok, true);
  // Should floor to 24.04 (below entry as required for LONG)
  assertEqual(result.stop, 24.04);
});

test("Integration: SHORT stop-loss with floating point artifacts", () => {
  // Simulate: entry = 24.05, risk = $0.05 from division
  const entryPrice = 24.05;
  const riskDollars = 0.05;
  const shares = 100;
  const computedStop = entryPrice + riskDollars / shares; // 24.05 + 0.0005 = 24.0505
  
  const result = normalizeStopPrice({
    side: "SHORT",
    entryPrice,
    stopPrice: computedStop,
  });
  
  assertEqual(result.ok, true);
  // Should ceil to 24.06 (above entry as required for SHORT)
  assertEqual(result.stop, 24.06);
});

// Summary
console.log("\n" + "=".repeat(60));
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(
  `Results: ${passed} passed, ${failed} failed out of ${results.length} tests`
);

if (failed > 0) {
  console.log("\nFailed tests:");
  results.filter((r) => !r.pass).forEach((r) => {
    console.log(`  - ${r.name}: ${r.error}`);
  });
  process.exit(1);
} else {
  console.log("\n✓ All tests passed!");
  process.exit(0);
}
