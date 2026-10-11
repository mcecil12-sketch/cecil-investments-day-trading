import { formatVzExposureLine, type VzExposure } from "@/lib/portfolio/vzExposure";

/**
 * Plain-data input for the Sunday snapshot export. Every section is nullable:
 * null means "couldn't be loaded", rendered as a one-line note rather than
 * failing the export. Account display names only — no numbers/IDs/emails.
 */
export interface SnapshotAccountRow {
  name: string;
  type: string;
  value: number;
  /** Per period: fractions (0.052 = 5.2%). Null = not reported. */
  periods: Record<"ytd" | "1y" | "3y", { ret: number | null; sp500: number | null; alpha: number | null } | null>;
  sincePurchase: { ret: number | null; sp500: number | null; alpha: number | null } | null;
  /** "fidelity_pdf" | "computed_total_return" | null (nothing reported). */
  dataSource: string | null;
  lastImportAt: Date | null;
}

export interface SnapshotTaxableRow {
  symbol: string;
  weight: number;
  unrealizedGain: number;
  compositeScore: number | null;
  fragilityFlag: boolean | null;
  insiderNetSoldUsd30d: number | null;
}

export interface SnapshotGroup3Row {
  rank: number;
  symbol: string;
  score: number;
  tracked: boolean;
  inTaxableAccount: boolean;
  fragilityFlag: boolean | null;
  insiderNetSoldUsd30d: number | null;
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
  group3: { monthKey: string; top10: SnapshotGroup3Row[]; sellCandidates: string[] } | null;
  brief: { weekOf: Date; cioSummary: string; performanceAnalysis: SnapshotAnalystText | null } | null;
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

function triple(p: { ret: number | null; sp500: number | null; alpha: number | null } | null): string {
  if (!p || p.ret == null) return "—";
  return `${pct(p.ret)} vs ${pct(p.sp500)} (α ${pct(p.alpha)})`;
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

  out.push("", "## 2. Unified portfolio");
  if (!data.portfolio) out.push(...missing("portfolio"));
  else {
    out.push(`Total value: **${money(data.portfolio.totalValue)}**`, "");
    out.push(
      ...table(
        ["Account", "Value", "YTD (ret vs S&P)", "1Y", "3Y", "Since purchase (price only)", "Source"],
        data.portfolio.accounts.map((a) => [
          a.name,
          money(a.value),
          triple(a.periods.ytd),
          triple(a.periods["1y"]),
          triple(a.periods["3y"]),
          a.sincePurchase ? triple(a.sincePurchase) : "—",
          a.dataSource ?? "none",
        ]),
      ),
    );
    out.push("", "_Since purchase uses a price-only S&P comparison; YTD/1Y/3Y use total return._");
  }

  out.push("", "## 3. Verizon-linked exposure");
  if (!data.vz) out.push(...missing("vz"));
  else {
    out.push(formatVzExposureLine(data.vz));
    if (data.vz.price) out.push(`VZ last: $${data.vz.price.last.toFixed(2)}`);
    else out.push("VZ price unavailable.");
    if (data.vz.components.length > 0) {
      out.push("", ...table(["Account", "Holding", "Value", "Basis"], data.vz.components.map((c) => [c.accountName, c.label, money(c.value), c.basis])));
    } else out.push("", "No Verizon-linked holdings matched.");
    for (const n of data.vz.notes) out.push(`- Note: ${n}`);
  }

  out.push("", "## 4. Taxable account holdings");
  if (!data.taxable) out.push(...missing("taxable"));
  else if (data.taxable.length === 0) out.push("_No taxable holdings on file._");
  else {
    out.push(
      ...table(
        ["Ticker", "Weight", "Unrealized gain", "Score", "Fragile", "Insider net sold 30d"],
        data.taxable.map((r) => [r.symbol, pct(r.weight), money(r.unrealizedGain), r.compositeScore == null ? "—" : String(r.compositeScore), flag(r.fragilityFlag), money(r.insiderNetSoldUsd30d)]),
      ),
    );
    out.push("", "_Score = Relative Strength composite (0-100). Fragility/insider shown only where the monthly scan logged the symbol._");
  }

  out.push("", "## 5. Group 3 (monthly top 10)");
  if (!data.group3) out.push(...missing("group3"));
  else {
    out.push(`Batch: ${data.group3.monthKey}`, "");
    out.push(
      ...table(
        ["Rank", "Ticker", "Score", "Tracked", "In taxable", "Fragile", "Insider net sold 30d"],
        data.group3.top10.map((r) => [String(r.rank), r.symbol, String(r.score), r.tracked ? "held" : "no", r.inTaxableAccount ? "yes" : "no", flag(r.fragilityFlag), money(r.insiderNetSoldUsd30d)]),
      ),
    );
    out.push("", `Sell candidates (hard top-10 rule): ${data.group3.sellCandidates.length > 0 ? data.group3.sellCandidates.join(", ") : "none"}`);
  }

  out.push("", "## 6. Latest weekly brief");
  if (!data.brief) out.push(...missing("brief"));
  else {
    out.push(`Week of ${etDate(data.brief.weekOf)}`, "", "### CIO narrative", data.brief.cioSummary, "", "### Performance Analyst");
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
