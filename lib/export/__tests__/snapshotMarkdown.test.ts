import { describe, expect, it } from "vitest";
import { buildSnapshotMarkdown, snapshotFilename, type SnapshotData } from "@/lib/export/snapshotMarkdown";

const now = new Date("2026-10-11T16:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const per = { ret: 0.052, sp500: 0.06, alpha: -0.008 };

function full(): SnapshotData {
  return {
    generatedAt: now,
    freshness: {
      lastImportByAccountType: [{ accountType: "FIDELITY_TAXABLE", at: daysAgo(2) }],
      lastWeeklyScan: daysAgo(3),
      lastMonthlyScan: daysAgo(10),
      lastWeeklyBrief: daysAgo(1),
      lastSentimentRun: daysAgo(0),
      sentimentCoveredSymbols: 150,
    },
    portfolio: {
      totalValue: 1234567.8,
      accounts: [
        { name: "Cecil Investments", type: "FIDELITY_TAXABLE", value: 500000, periods: { ytd: per, "1y": per, "3y": null }, sincePurchase: per, dataSource: "fidelity_pdf", lastImportAt: daysAgo(2) },
        { name: "Verizon LTI", type: "VZ_LTI", value: 400000, periods: { ytd: per, "1y": null, "3y": null }, sincePurchase: null, dataSource: "computed_total_return", lastImportAt: daysAgo(20) },
      ],
    },
    vz: {
      totalValue: 450000,
      percentOfPortfolio: 0.364,
      components: [{ accountName: "Verizon LTI", accountType: "VZ_LTI", label: "8,199 VZ shares x $50.22", value: 411771, basis: "lti_shares_x_live_price" }],
      price: { last: 50.22, dayChangePct: 0.01, ytdChangePct: 0.1 },
      notes: [],
    },
    taxable: [{ symbol: "FSELX", weight: 0.4, unrealizedGain: 12345.6, compositeScore: 81, fragilityFlag: true, insiderNetSoldUsd30d: 1_000_000 }],
    group3: {
      monthKey: "monthly-2026-10",
      top10: [{ rank: 1, symbol: "NVDA", score: 90, tracked: true, inTaxableAccount: false, fragilityFlag: false, insiderNetSoldUsd30d: null }],
      sellCandidates: ["AMD"],
    },
    brief: {
      weekOf: daysAgo(1),
      cioSummary: "Trim FSELX | keep calm.",
      performanceAnalysis: {
        topWinnerPatterns: ["Strong momentum"],
        topLoserPatterns: [],
        bestSetupTypes: [],
        scoreVsRealizedRNote: "r = 0.2",
        earlyExitPatterns: [],
        sentimentSignalNote: null,
        fragilityNote: "Flagged underperform",
        insiderNote: null,
      },
    },
  };
}

describe("buildSnapshotMarkdown", () => {
  it("renders all sections with rounded figures and no raw identifiers", () => {
    const md = buildSnapshotMarkdown(full());
    for (const h of ["## 1.", "## 2.", "## 3.", "## 4.", "## 5.", "## 6.", "## 7."]) expect(md).toContain(h);
    expect(md).toContain("$1,234,568");
    expect(md).toContain("5.2% vs 6.0% (α -0.8%)");
    expect(md).toContain("fidelity_pdf");
    expect(md).toContain("price only");
    expect(md).toContain("Verizon-linked exposure: $450,000 (36.4% of portfolio)");
    expect(md).toContain("FSELX | 40.0% | $12,346 | 81 | yes | $1,000,000");
    expect(md).toContain("Sell candidates (hard top-10 rule): AMD");
    expect(md).toContain("Trim FSELX | keep calm.");
    expect(md.split("\n").length).toBeLessThan(300);
  });

  it("renders null analyst fields as null, never invented text, and warns", () => {
    const md = buildSnapshotMarkdown(full());
    expect(md).toContain("**Sentiment signal:** null (insufficient data)");
    expect(md).toContain("**Insider:** null (insufficient data)");
    expect(md).toContain("Sentiment note is null");
    expect(md).toContain("Insider note is null");
    expect(md).not.toContain("Fragility note is null");
  });

  it("renders scan health and lifts DEGRADED/FAILED reasons into Warnings", () => {
    const d = full();
    d.scanHealth = [
      { kind: "MONTHLY_SCAN", status: "HEALTHY", reasons: [], createdAt: daysAgo(1) },
      { kind: "WEEKLY_BRIEF", status: "DEGRADED", reasons: ["Claude call failed — CIO brief: BILLING/CREDIT: credit balance is too low"], createdAt: daysAgo(0) },
    ];
    const md = buildSnapshotMarkdown(d);
    expect(md).toContain("### Scan health");
    expect(md).toContain("| WEEKLY_BRIEF | DEGRADED |");
    expect(md).toContain("Scan health WEEKLY_BRIEF DEGRADED: Claude call failed — CIO brief: BILLING/CREDIT");
    expect(md).not.toContain("Scan health MONTHLY_SCAN");
  });

  it("renders a wholly null analyst output as null", () => {
    const d = full();
    d.brief!.performanceAnalysis = null;
    const md = buildSnapshotMarkdown(d);
    expect(md).toContain("Performance Analyst output: null");
    expect(md).toContain("Performance Analyst section is null");
  });

  it("flags imports older than 7 days and overdue crons", () => {
    const d = full();
    d.freshness!.lastSentimentRun = daysAgo(5);
    const md = buildSnapshotMarkdown(d);
    expect(md).toContain("Import stale: Verizon LTI");
    expect(md).not.toContain("Import stale: Cecil Investments");
    expect(md).toContain("Cron overdue: Sentiment cron");
  });

  it("skips missing sections with a one-line note and never throws", () => {
    const md = buildSnapshotMarkdown({
      generatedAt: now,
      freshness: null,
      portfolio: null,
      vz: null,
      taxable: null,
      group3: null,
      brief: null,
      loadErrors: { portfolio: "db down" },
    });
    expect(md).toContain("portfolio: data unavailable (db down)");
    expect(md).toContain("## 7. Warnings");
    expect(md).toContain('Section "portfolio" failed to load');
  });
});

describe("snapshotFilename", () => {
  it("uses the ET calendar date", () => {
    expect(snapshotFilename(new Date("2026-10-11T02:00:00Z"))).toBe("cecil-snapshot-2026-10-10.md");
  });
});
