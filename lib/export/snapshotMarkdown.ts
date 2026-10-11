import { formatVzExposureLine, type VzExposure } from "@/lib/portfolio/vzExposure";
import type { DisplayRow } from "@/lib/benchmark/displayRows";
import { STALE_BRIEF_DAYS, briefAgeDays, type AccountAllocation, type SleeveScoreboard, type ThemeConcentration } from "@/lib/export/sleeveMath";

/**
 * Plain-data input for the Sunday snapshot export. Every section is nullable:
 * null means "couldn't be loaded", rendered as a one-line note rather than
 * failing the export. Account display names only — no numbers/IDs/emails.
 */
export interface SnapshotAccountRow {
  name: string;
  type: string;
  value: number;
  /** Latest PDF as-of date across this row's windows (LTI: latest close). */
  asOf: Date | null;
  /** Per window, already computed against the single S&P comparator (see lib/benchmark/displayRows.ts). */
  windows: DisplayRow["windows"];
  lastImportAt: Date | null;
}

export interface SnapshotTaxableRow {
  symbol: string;
  weight: number;
  unrealizedGain: number;
  compositeScore: number | null;
  fragilityFlag: boolean | null;
  insiderNetSoldUsd30d: number | null;
  /** EDGAR returned a valid result with no sales/purchases in the window: shown as "$0 (no filings)", not n/a. */
  insiderNoFilings?: boolean;
  insiderPctOfMarketCap?: number | null;
}

export interface SnapshotGroup3Row {
  rank: number;
  symbol: string;
  score: number;
  tracked: boolean;
  inTaxableAccount: boolean;
  fragilityFlag: boolean | null;
  insiderNetSoldUsd30d: number | null;
  insiderNoFilings?: boolean;
  insiderPctOfMarketCap?: number | null;
}

export interface SnapshotAnalystText {
  topWinnerPatterns: string[];
  topLoserPatterns: string[];
  bestSetupTypes: string[];
  scoreVsRealizedRNote: string;
  earlyExitPatterns: string[];
  sentimentSignalNote: string | null;
  fragilityNote: string | null;
  insiderNote: string | null;
}

export interface SnapshotData {
  generatedAt: Date;
  freshness: {
    lastImportByAccountType: Array<{ accountType: string; at: Date | null }>;
    lastWeeklyScan: Date | null;
    lastMonthlyScan: Date | null;
    lastWeeklyBrief: Date | null;
    lastSentimentRun: Date | null;
    sentimentCoveredSymbols: number | null;
  } | null;
  portfolio: { totalValue: number; accounts: SnapshotAccountRow[] } | null;
  vz: VzExposure | null;
  taxable: SnapshotTaxableRow[] | null;
  group3: { monthKey: string; batchDate?: Date | null; top10: SnapshotGroup3Row[]; sellCandidates: string[] } | null;
  allocation?: AccountAllocation[] | null;
  sleeve?: { scoreboard: SleeveScoreboard | null; theme: ThemeConcentration | null; avgCorrelation60d: number | null; sleeveSize: number; controlSymbol: string; unavailableReason?: string } | null;
  /** Data-quality warnings from the benchmark display layer (S&P mismatches, differing as-of dates, young accounts). */
  benchmarkWarnings?: string[];
  brief: { weekOf: Date; cioSummary: string; performanceAnalysis: SnapshotAnalystText | null } | null;
  scanHealth?: Array<{ kind: string; status: string; reasons: string[]; createdAt: Date }> | null;
  /** Section name -> reason, for sections whose loader threw. */
  loadErrors?: Record<string, string>;
}

/** Cron windows: a job is flagged when its last run is older than this. Mirrors vercel.json cadence with slack. */
export const STALE_AFTER_DAYS = {
  import: 7,
  weeklyScan: 8,
  weeklyBrief: 8,
  monthlyScan: 35,
  sentiment: 2,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

const money = (v: number | null) => (v == null ? "—" : `${v < 0 ? "-" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`);
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
/** Insider net sold cell: "$0 (no filings)" for a valid EDGAR zero, "n/a" for failed/unattempted, plus % of market cap when known. */
export function insiderCell(r: { insiderNetSoldUsd30d: number | null; insiderNoFilings?: boolean; insiderPctOfMarketCap?: number | null }): string {
  if (r.insiderNoFilings) return "$0 (no filings)";
  if (r.insiderNetSoldUsd30d == null) return "n/a";
  const base = money(r.insiderNetSoldUsd30d);
  return r.insiderPctOfMarketCap != null ? `${base} (${r.insiderPctOfMarketCap.toFixed(3)}% of cap)` : base;
}
const flag = (v: boolean | null) => (v == null ? "—" : v ? "yes" : "no");
const cell = (v: string) => v.replace(/\|/g, "/").replace(/\s*\n\s*/g, " ");

function et(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour") === "24" ? "00" : get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}
const etDate = (d: Date | null) => (d ? et(d).slice(0, 10) : "never");
const ago = (d: Date | null, now: Date) => (d ? `${etDate(d)} (${Math.floor((now.getTime() - d.getTime()) / DAY_MS)}d ago)` : "never");

function table(headers: string[], rows: string[][]): string[] {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

function windowCell(w: DisplayRow["windows"]["ytd"]): string {
  if (w.status === "too_young") return "— (account younger than window)";
  if (w.status !== "ok" || w.returnPct == null) return "—";
  const label = w.source === "proxy_vz_total_return" ? " [proxy: VZ stock total return]" : "";
  return `${pct(w.returnPct)} vs ${pct(w.sp500)} (α ${pct(w.alpha)})${label}`;
}

export function snapshotFilename(date: Date): string {
  return `cecil-snapshot-${etDate(date)}.md`;
}

/** Warnings derived from the data: stale imports/crons and null analyst sections. */
export function buildSnapshotWarnings(data: SnapshotData): string[] {
  const now = data.generatedAt;
  const warnings: string[] = [];
  const older = (d: Date | null, days: number) => d == null || now.getTime() - d.getTime() > days * DAY_MS;

  if (data.portfolio) {
    for (const a of data.portfolio.accounts) {
      if (older(a.lastImportAt, STALE_AFTER_DAYS.import)) {
        warnings.push(`Import stale: ${a.name} — last import ${ago(a.lastImportAt, now)} (limit ${STALE_AFTER_DAYS.import}d).`);
      }
    }
  }
  const f = data.freshness;
  if (f) {
    const crons: Array<[string, Date | null, number]> = [
      ["Weekly scan", f.lastWeeklyScan, STALE_AFTER_DAYS.weeklyScan],
      ["Weekly brief", f.lastWeeklyBrief, STALE_AFTER_DAYS.weeklyBrief],
      ["Monthly scan", f.lastMonthlyScan, STALE_AFTER_DAYS.monthlyScan],
      ["Sentiment cron", f.lastSentimentRun, STALE_AFTER_DAYS.sentiment],
    ];
    for (const [label, at, days] of crons) {
      if (older(at, days)) warnings.push(`Cron overdue: ${label} — last run ${ago(at, now)} (expected within ${days}d).`);
    }
  }
  const pa = data.brief?.performanceAnalysis;
  if (data.brief && !pa) {
    warnings.push("Performance Analyst section is null for the latest brief (no API key configured, or not enough tracked-position history yet).");
  } else if (pa) {
    if (pa.sentimentSignalNote == null) warnings.push("Sentiment note is null: sentiment history not yet sufficient (age/breadth guard).");
    if (pa.fragilityNote == null) warnings.push("Fragility note is null: not enough closed Group 3 positions/monthly cycles yet.");
    if (pa.insiderNote == null) warnings.push("Insider note is null: not enough closed Group 3 positions/monthly cycles with insider data yet.");
  }
  for (const w of data.benchmarkWarnings ?? []) warnings.push(w);
  for (const h of data.scanHealth ?? []) {
    if (h.status === "HEALTHY") continue;
    for (const r of h.reasons) warnings.push(`Scan health ${h.kind} ${h.status}: ${r}`);
  }
  for (const [section, reason] of Object.entries(data.loadErrors ?? {})) {
    warnings.push(`Section "${section}" failed to load: ${reason}`);
  }
  return warnings;
}

function listBlock(title: string, items: string[]): string[] {
  return [`**${title}**`, ...(items.length > 0 ? items.map((i) => `- ${i}`) : ["- (none)"])];
}

export function buildSnapshotMarkdown(data: SnapshotData): string {
  const now = data.generatedAt;
  const missing = (name: string) => [`_${name}: data unavailable${data.loadErrors?.[name] ? ` (${data.loadErrors[name]})` : ""}._`];
  const out: string[] = [];

  out.push(`# Cecil portfolio snapshot`, "", `Generated: ${et(now)}`, "");

  out.push("## 1. Data freshness");
  const f = data.freshness;
  if (!f) out.push(...missing("freshness"));
  else {
    out.push(
      ...table(
        ["Item", "Last"],
        [
          ...f.lastImportByAccountType.map((r) => [`Import — ${r.accountType}`, ago(r.at, now)]),
          ["Weekly scan", ago(f.lastWeeklyScan, now)],
          ["Weekly brief", ago(f.lastWeeklyBrief, now)],
          ["Monthly scan", ago(f.lastMonthlyScan, now)],
          ["Sentiment cron", `${ago(f.lastSentimentRun, now)}; ${f.sentimentCoveredSymbols ?? "?"} symbols covered`],
        ],
      ),
    );
  }

  out.push("", "### Scan health");
  if (data.scanHealth == null) out.push("_scan health: no results recorded yet._");
  else if (data.scanHealth.length === 0) out.push("_No scan health results recorded yet._");
  else out.push(...table(["Kind", "Status", "When", "Issues"], data.scanHealth.map((h) => [h.kind, h.status, ago(h.createdAt, now), String(h.reasons.length)])));

  out.push("", "## 2. Unified portfolio");
  if (!data.portfolio) out.push(...missing("portfolio"));
  else {
    out.push(`Total value: **${money(data.portfolio.totalValue)}**`, "");
    out.push(
      ...table(
        ["Account", "Value", "As of", "YTD (ret vs S&P TR)", "1Y", "3Y annualized"],
        data.portfolio.accounts.map((a) => [a.name, money(a.value), a.asOf ? etDate(a.asOf) : "—", windowCell(a.windows.ytd), windowCell(a.windows["1y"]), windowCell(a.windows["3y"])]),
      ),
    );
    out.push("", "_Every S&P figure is ^SP500TR (total return) over that row's own as-of window; 3Y is annualized (CAGR)._");
  }

  out.push("", "## 3. Verizon-linked exposure");
  if (!data.vz) out.push(...missing("vz"));
  else {
    out.push(formatVzExposureLine(data.vz));
    out.push(data.vz.price ? `VZ last: $${data.vz.price.last.toFixed(2)}` : "VZ price unavailable.");
    out.push(
      "",
      ...table(
        ["View", "Dollars", "% of matching total"],
        [
          ["Including unvested LTI", money(data.vz.totalValue), pct(data.vz.percentOfPortfolio)],
          ["Excluding unvested LTI", money(data.vz.excludingLti.totalValue), pct(data.vz.excludingLti.percentOfPortfolio)],
        ],
      ),
    );
    if (data.vz.components.length > 0) {
      out.push("", "**Counted**", ...table(["Account", "Holding", "Value", "Basis"], data.vz.components.map((c) => [c.accountName, c.label, money(c.value), c.basis])));
    } else out.push("", "No Verizon-linked holdings matched.");
    out.push("", "**Excluded**");
    if (data.vz.excluded.length > 0) out.push(...table(["Account", "Holding", "Value", "Reason"], data.vz.excluded.map((x) => [x.accountName, x.label, money(x.value), x.reason])));
    else out.push("None.");
    for (const n of data.vz.notes) out.push(`- Note: ${n}`);
  }

  out.push("", "## 4. Taxable account holdings");
  if (!data.taxable) out.push(...missing("taxable"));
  else if (data.taxable.length === 0) out.push("_No taxable holdings on file._");
  else {
    out.push(
      ...table(
        ["Ticker", "Weight", "Unrealized gain", "Score", "Fragile", "Insider net sold 30d"],
        data.taxable.map((r) => [r.symbol, pct(r.weight), money(r.unrealizedGain), r.compositeScore == null ? "—" : String(r.compositeScore), flag(r.fragilityFlag), insiderCell(r)]),
      ),
    );
    out.push("", "_Score = Relative Strength composite (0-100). Fragility/insider shown only where the monthly scan logged the symbol._");
  }

  out.push("", "### Allocation by taxable account");
  if (data.allocation == null) out.push(...missing("allocation"));
  else if (data.allocation.length === 0) out.push("_No taxable accounts on file._");
  else {
    out.push(
      ...table(
        ["Account", "Value", "Top-10 sleeve $", "Sleeve %", "S&P fund $", "S&P fund %", "Other %", "Cash %"],
        data.allocation.map((a) => [a.name, money(a.value), money(a.sleeveValue), pct(a.sleevePct), money(a.sp500FundValue), pct(a.sp500FundPct), pct(a.otherPct), pct(a.cashPct)]),
      ),
    );
  }

  out.push("", "## 5. Group 3 (monthly top 10)");
  if (!data.group3) out.push(...missing("group3"));
  else {
    out.push(`Batch: ${data.group3.monthKey}`, "");
    out.push(
      ...table(
        ["Rank", "Ticker", "Score", "Tracked", "In taxable", "Fragile", "Insider net sold 30d"],
        data.group3.top10.map((r) => [String(r.rank), r.symbol, String(r.score), r.tracked ? "held" : "no", r.inTaxableAccount ? "yes" : "no", flag(r.fragilityFlag), insiderCell(r)]),
      ),
    );
    out.push("", `Sell candidates (hard top-10 rule): ${data.group3.sellCandidates.length > 0 ? data.group3.sellCandidates.join(", ") : "none"}`);
  }

  out.push("", "### Sleeve scoreboard — model sleeve since batch date, not since purchase");
  const sl = data.sleeve;
  if (!sl || !sl.scoreboard) out.push(`_Sleeve scoreboard: data unavailable${sl?.unavailableReason ? ` (${sl.unavailableReason})` : ""}._`);
  else {
    const sb = sl.scoreboard;
    out.push(
      `Group 3 top-10 names held in taxable accounts (${sb.names.length}), equal-weighted, ${etDate(sb.startDate)} to ${etDate(sb.endDate)}. Some names may have been held before the batch date, so this is not a since-purchase return.`,
      "",
      ...table(["Name", "Return", "Contribution"], sb.names.map((n) => [n.symbol, pct(n.ret), pct(n.contribution)])),
      "",
      ...table(
        ["Comparison", "Return"],
        [
          ["Sleeve (equal-weight)", pct(sb.sleeveReturn)],
          ["^SP500TR", pct(sb.indexReturn)],
          [`${sl.controlSymbol} (in-account control)`, pct(sb.controlReturn)],
          ["Sleeve minus ^SP500TR", pct(sb.excessVsIndex)],
        ],
      ),
    );
    if (sb.missing.length > 0) out.push(`Missing price history: ${sb.missing.join(", ")}`);
  }

  out.push("", "### Theme concentration");
  if (!sl || !sl.theme) out.push("_Theme concentration: data unavailable._");
  else {
    out.push(
      sl.theme.largest ? `Largest cluster: ${sl.theme.largest.sector} at ${pct(sl.theme.largest.share)} of the sleeve (${sl.sleeveSize} names).` : "No sleeve names.",
      `Average pairwise correlation, last 60 trading days: ${sl.avgCorrelation60d == null ? "—" : sl.avgCorrelation60d.toFixed(2)}`,
      "",
      ...table(["Sector", "Names", "Share"], sl.theme.clusters.map((c) => [c.sector, c.symbols.join(", "), pct(c.share)])),
    );
  }

  out.push("", "## 6. Latest weekly brief");
  if (!data.brief) out.push(...missing("brief"));
  else {
    const age = briefAgeDays(data.brief.weekOf, now);
    out.push(`Week of ${data.brief.weekOf.toISOString().slice(0, 10)} (age: ${age} days)`);
    if (age > STALE_BRIEF_DAYS) out.push("", `**STALE: this brief is ${age} days old, treat positions and recommendations as out of date**`);
    out.push("", "### CIO narrative", data.brief.cioSummary, "", "### Performance Analyst");
    const pa = data.brief.performanceAnalysis;
    if (!pa) out.push("Performance Analyst output: null (insufficient data or not run).");
    else {
      out.push(
        ...listBlock("Top winner patterns", pa.topWinnerPatterns),
        ...listBlock("Top loser patterns", pa.topLoserPatterns),
        ...listBlock("Best setup types", pa.bestSetupTypes),
        `**Score vs realized R:** ${pa.scoreVsRealizedRNote}`,
        ...listBlock("Early exit patterns", pa.earlyExitPatterns),
        `**Sentiment signal:** ${pa.sentimentSignalNote ?? "null (insufficient data)"}`,
        `**Fragility:** ${pa.fragilityNote ?? "null (insufficient data)"}`,
        `**Insider:** ${pa.insiderNote ?? "null (insufficient data)"}`,
      );
    }
  }

  out.push("", "## 7. Warnings");
  const warnings = buildSnapshotWarnings(data);
  out.push(...(warnings.length > 0 ? warnings.map((w) => `- ${w}`) : ["- None."]));

  return out.join("\n") + "\n";
}
