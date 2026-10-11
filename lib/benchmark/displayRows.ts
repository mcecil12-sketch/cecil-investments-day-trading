import type { PricePoint } from "@/lib/agents/marketData";
import {
  computeSp500Period,
  computeWindowReturn,
  windowStartDate,
  utcDay,
  type ComparatorPeriod,
} from "@/lib/benchmark/sp500Comparator";

/** Display-only layer: re-expresses each account's stored return against the single S&P comparator. Engine math is untouched. */
export const MISMATCH_THRESHOLD = 0.005; // 0.5 percentage points

export type WindowStatus = "ok" | "too_young" | "no_data";

export interface DisplayWindow {
  period: ComparatorPeriod;
  status: WindowStatus;
  /** Account (or proxy) return over the window; 3Y annualized. Null unless status is "ok". */
  returnPct: number | null;
  sp500: number | null;
  alpha: number | null;
  /** The S&P figure the Fidelity PDF carried for this row, when there was one. */
  pdfSp500: number | null;
  asOf: Date | null;
  windowStart: Date | null;
  annualized: boolean;
  /** "pdf" rows come from Fidelity's PDF; "proxy" is VZ stock total return standing in for the LTI account. */
  source: "fidelity_pdf" | "proxy_vz_total_return" | null;
}

export interface DisplayRow {
  key: string;
  name: string;
  type: string;
  value: number;
  asOf: Date | null;
  windows: Record<ComparatorPeriod, DisplayWindow>;
}

export interface PdfPeriodInput {
  returnPct: number | null;
  pdfSp500: number | null;
  asOf: Date | null;
}

export interface DisplayAccountInput {
  key: string;
  name: string;
  type: string;
  value: number;
  /** Fidelity "life of data" start — an account younger than a window shows "—" for it. */
  inceptionDate: Date | null;
  pdf: Partial<Record<ComparatorPeriod, PdfPeriodInput>>;
}

const PERIODS: ComparatorPeriod[] = ["ytd", "1y", "3y"];

function emptyWindow(period: ComparatorPeriod, status: WindowStatus, extra: Partial<DisplayWindow> = {}): DisplayWindow {
  return { period, status, returnPct: null, sp500: null, alpha: null, pdfSp500: null, asOf: null, windowStart: null, annualized: period === "3y", source: null, ...extra };
}

function pdfWindow(period: ComparatorPeriod, input: DisplayAccountInput, sp500Series: PricePoint[]): DisplayWindow {
  const pdf = input.pdf[period];
  if (!pdf || pdf.returnPct == null || !pdf.asOf) return emptyWindow(period, "no_data");
  const start = windowStartDate(period, pdf.asOf);
  // Younger than the window: Fidelity-style "—", never a partial figure presented as full.
  if (input.inceptionDate && utcDay(input.inceptionDate) > utcDay(start)) {
    return emptyWindow(period, "too_young", { asOf: pdf.asOf, windowStart: start, pdfSp500: pdf.pdfSp500 });
  }
  const sp = computeSp500Period(sp500Series, period, pdf.asOf);
  return {
    period,
    status: "ok",
    returnPct: pdf.returnPct,
    sp500: sp?.value ?? null,
    alpha: sp ? pdf.returnPct - sp.value : null,
    pdfSp500: pdf.pdfSp500,
    asOf: pdf.asOf,
    windowStart: start,
    annualized: period === "3y",
    source: "fidelity_pdf",
  };
}

/** Rows for PDF-sourced accounts (and the Total row), each against the comparator over its own as-of window. */
export function buildPdfDisplayRow(input: DisplayAccountInput, sp500Series: PricePoint[]): DisplayRow {
  const windows = Object.fromEntries(PERIODS.map((p) => [p, pdfWindow(p, input, sp500Series)])) as Record<ComparatorPeriod, DisplayWindow>;
  const asOfs = PERIODS.map((p) => windows[p].asOf?.getTime()).filter((t): t is number => t != null);
  return { key: input.key, name: input.name, type: input.type, value: input.value, asOf: asOfs.length ? new Date(Math.max(...asOfs)) : null, windows };
}

/** VZ_LTI: VZ stock total return vs the same comparator over identical windows ending at the latest close both series share. 3Y is annualized and labeled a proxy. */
export function buildLtiDisplayRow(
  input: { key: string; name: string; type: string; value: number },
  vzSeries: PricePoint[],
  sp500Series: PricePoint[],
): DisplayRow {
  const lastVz = vzSeries.length ? Math.max(...vzSeries.map((p) => p.date.getTime())) : null;
  const lastSp = sp500Series.length ? Math.max(...sp500Series.map((p) => p.date.getTime())) : null;
  const end = lastVz != null && lastSp != null ? new Date(Math.min(lastVz, lastSp)) : null;
  const windows = Object.fromEntries(
    PERIODS.map((period) => {
      if (!end) return [period, emptyWindow(period, "no_data")];
      const start = windowStartDate(period, end);
      const vz = computeWindowReturn(vzSeries, start, end, period === "3y");
      const sp = computeWindowReturn(sp500Series, start, end, period === "3y");
      if (!vz || !sp) return [period, emptyWindow(period, "too_young", { asOf: end, windowStart: start })];
      return [period, { period, status: "ok", returnPct: vz.value, sp500: sp.value, alpha: vz.value - sp.value, pdfSp500: null, asOf: end, windowStart: start, annualized: period === "3y", source: "proxy_vz_total_return" } satisfies DisplayWindow];
    }),
  ) as Record<ComparatorPeriod, DisplayWindow>;
  return { key: input.key, name: input.name, type: input.type, value: input.value, asOf: end, windows };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const pp = (x: number) => `${(x * 100).toFixed(1)}pp`;

/** Data-quality warnings: PDF-vs-comparator S&P gaps over 0.5pp, mismatched as-of dates, accounts with no data. */
export function buildBenchmarkWarnings(rows: DisplayRow[]): string[] {
  const warnings: string[] = [];
  for (const row of rows) {
    for (const p of PERIODS) {
      const w = row.windows[p];
      if (w.status !== "ok" || w.sp500 == null || w.pdfSp500 == null || !w.asOf) continue;
      const diff = w.sp500 - w.pdfSp500;
      if (Math.abs(diff) > MISMATCH_THRESHOLD) {
        warnings.push(
          `S&P mismatch: ${row.name} ${p.toUpperCase()}${w.annualized ? " (annualized)" : ""} as of ${iso(w.asOf)} — comparator ${(w.sp500 * 100).toFixed(1)}% vs PDF ${(w.pdfSp500 * 100).toFixed(1)}% (${pp(diff)} apart; limit 0.5pp).`,
        );
      }
    }
  }
  // LTI is live (latest close), so only PDF-sourced accounts are compared on as-of date.
  const withDates = rows.filter((r) => r.type !== "VZ_LTI" && r.asOf);
  const distinct = new Set(withDates.map((r) => iso(r.asOf!)));
  if (distinct.size > 1) {
    warnings.push(
      `As-of dates differ across accounts (${withDates.map((r) => `${r.name} ${iso(r.asOf!)}`).join("; ")}) — re-upload the Performance PDF for same-day comparability.`,
    );
  }
  const noData = rows.filter((r) => r.type !== "VZ_LTI" && PERIODS.every((p) => r.windows[p].status === "no_data"));
  if (noData.length > 0) warnings.push(`No performance rows on file: ${noData.map((r) => r.name).join(", ")}.`);
  const young = rows.filter((r) => PERIODS.some((p) => r.windows[p].status === "too_young") && r.type !== "VZ_LTI");
  for (const r of young) {
    const which = PERIODS.filter((p) => r.windows[p].status === "too_young").map((p) => p.toUpperCase()).join("/");
    warnings.push(`${r.name} is younger than the ${which} window${which.includes("/") ? "s" : ""} — shown as "—" (any stored figure is for a shorter period).`);
  }
  return warnings;
}
