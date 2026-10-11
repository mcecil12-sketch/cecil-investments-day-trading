import { describe, expect, it } from "vitest";
import { buildBenchmarkWarnings, buildLtiDisplayRow, buildPdfDisplayRow } from "@/lib/benchmark/displayRows";
import type { PricePoint } from "@/lib/agents/marketData";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const series = (entries: Array<[string, number]>): PricePoint[] => entries.map(([date, close]) => ({ date: d(date), close }));

// ^SP500TR: +25% YTD to 9/30 (160 -> 200), +33.3% 1Y (150 -> 200), 3Y doubled.
const sp = series([["2023-09-29", 100], ["2025-09-30", 150], ["2025-12-31", 160], ["2026-09-30", 200], ["2026-10-09", 210]]);

const base = { key: "a", name: "Acct", type: "FIDELITY_TAXABLE", value: 1000 };

describe("buildPdfDisplayRow", () => {
  it("compares each row against the comparator over its own as-of window", () => {
    const row = buildPdfDisplayRow(
      { ...base, inceptionDate: d("2020-01-01"), pdf: { ytd: { returnPct: 0.3, pdfSp500: 0.25, asOf: d("2026-09-30") } } },
      sp,
    );
    expect(row.windows.ytd.sp500).toBeCloseTo(0.25);
    expect(row.windows.ytd.alpha).toBeCloseTo(0.05);
    expect(row.windows["1y"].status).toBe("no_data");
    expect(row.asOf?.toISOString().slice(0, 10)).toBe("2026-09-30");
  });

  it("a stale as-of date gets its own window — not the latest one", () => {
    const row = buildPdfDisplayRow({ ...base, inceptionDate: null, pdf: { ytd: { returnPct: 0.1, pdfSp500: null, asOf: d("2025-12-31") } } }, series([["2024-12-31", 100], ["2025-12-31", 120]]));
    expect(row.windows.ytd.sp500).toBeCloseTo(0.2);
  });

  it("shows '—' (too_young) for windows longer than the account's life, with no figures", () => {
    const row = buildPdfDisplayRow(
      { ...base, name: "Cecil Investments", inceptionDate: d("2026-03-31"), pdf: { ytd: { returnPct: 0.1548, pdfSp500: 0.1021, asOf: d("2026-06-30") }, "1y": { returnPct: 0.2523, pdfSp500: 0.2232, asOf: d("2026-06-30") } } },
      sp,
    );
    for (const p of ["ytd", "1y", "3y"] as const) expect(row.windows[p].returnPct).toBeNull();
    expect(row.windows.ytd.status).toBe("too_young");
    expect(row.windows["1y"].status).toBe("too_young");
  });

  it("annualizes the comparator for 3Y", () => {
    const row = buildPdfDisplayRow({ ...base, inceptionDate: null, pdf: { "3y": { returnPct: 0.3, pdfSp500: 0.26, asOf: d("2026-09-30") } } }, sp);
    expect(row.windows["3y"].annualized).toBe(true);
    expect(row.windows["3y"].sp500).toBeCloseTo(Math.pow(2, 1 / 3) - 1, 3);
  });
});

describe("buildLtiDisplayRow", () => {
  it("computes VZ vs the comparator over identical windows, flagged as a proxy, 3Y annualized", () => {
    const vz = series([["2023-09-29", 40], ["2025-09-30", 40], ["2025-12-31", 40], ["2026-09-30", 50], ["2026-10-09", 55]]);
    const row = buildLtiDisplayRow({ ...base, type: "VZ_LTI" }, vz, sp);
    expect(row.asOf?.toISOString().slice(0, 10)).toBe("2026-10-09");
    const ytd = row.windows.ytd;
    expect(ytd.source).toBe("proxy_vz_total_return");
    expect(ytd.returnPct).toBeCloseTo(55 / 40 - 1);
    expect(ytd.sp500).toBeCloseTo(210 / 160 - 1);
    expect(ytd.alpha).toBeCloseTo(55 / 40 - 210 / 160);
    expect(row.windows["3y"].annualized).toBe(true);
    expect(row.windows["3y"].returnPct).toBeCloseTo(Math.pow(55 / 40, 1 / 3) - 1, 3);
  });
});

describe("buildBenchmarkWarnings", () => {
  const mk = (name: string, asOf: string, returnPct: number, pdfSp500: number) =>
    buildPdfDisplayRow({ ...base, key: name, name, inceptionDate: null, pdf: { ytd: { returnPct, pdfSp500, asOf: d(asOf) } } }, sp);

  it("warns when the PDF S&P differs from the comparator by more than 0.5pp", () => {
    const warnings = buildBenchmarkWarnings([mk("Off", "2026-09-30", 0.3, 0.2)]);
    expect(warnings.some((w) => /S&P mismatch: Off YTD/.test(w) && /25\.0% vs PDF 20\.0%/.test(w))).toBe(true);
  });

  it("does not warn within 0.5pp", () => {
    expect(buildBenchmarkWarnings([mk("Close", "2026-09-30", 0.3, 0.2540)]).filter((w) => /mismatch/.test(w))).toEqual([]);
  });

  it("warns when as-of dates differ across accounts, listing each", () => {
    const warnings = buildBenchmarkWarnings([mk("A", "2026-09-30", 0.3, 0.25), mk("B", "2025-12-31", 0.3, 0.25)]);
    const w = warnings.find((x) => /As-of dates differ/.test(x))!;
    expect(w).toContain("A 2026-09-30");
    expect(w).toContain("B 2025-12-31");
    expect(w).toContain("re-upload");
  });

  it("flags young accounts and accounts with no rows", () => {
    const young = buildPdfDisplayRow({ ...base, name: "Cecil", inceptionDate: d("2026-03-31"), pdf: { ytd: { returnPct: 0.1, pdfSp500: 0.1, asOf: d("2026-06-30") } } }, sp);
    const none = buildPdfDisplayRow({ ...base, name: "Empty", inceptionDate: null, pdf: {} }, sp);
    const warnings = buildBenchmarkWarnings([young, none]);
    expect(warnings.some((w) => /Cecil is younger than the YTD window/.test(w))).toBe(true);
    expect(warnings.some((w) => /No performance rows on file: Empty/.test(w))).toBe(true);
  });
});
