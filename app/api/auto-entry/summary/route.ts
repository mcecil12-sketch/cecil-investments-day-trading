import { NextResponse } from "next/server";
import { readAutoEntryTelemetry } from "@/lib/autoEntry/telemetry";
import { getEtDateString } from "@/lib/time/etDate";

export const dynamic = "force-dynamic";

type Bucket = {
  start: string;
  end: string;
  runs: number;
  success: number;
  fail: number;
  skipped: number;
  skipByReason: Record<string, number>;
  lastRunAt: string | null;
  lastOutcome: string | null;
  lastReason: string | null;
  lastSource: string | null;
  lastRunId: string | null;
};

function toNum(x: any) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function emptyBucket(start: string, end: string): Bucket {
  return {
    start,
    end,
    runs: 0,
    success: 0,
    fail: 0,
    skipped: 0,
    skipByReason: {},
    lastRunAt: null,
    lastOutcome: null,
    lastReason: null,
    lastSource: null,
    lastRunId: null,
  };
}

function startOfWeekET(isoDate: string) {
  const d = new Date(isoDate + "T00:00:00.000-05:00");
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

function startOfMonth(isoDate: string) {
  return isoDate.slice(0, 8) + "01";
}

function startOfYear(isoDate: string) {
  return isoDate.slice(0, 4) + "-01-01";
}

function dateRange(startIso: string, endIso: string) {
  const out: string[] = [];
  const d = new Date(startIso + "T00:00:00.000Z");
  const end = new Date(endIso + "T00:00:00.000Z");
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function mergeBucket(acc: Bucket, daySummary: any): Bucket {
  if (!daySummary || typeof daySummary !== "object") return acc;

  acc.runs += toNum(daySummary.runs);
  acc.skipped += toNum(daySummary.skipped);

  const success = toNum(daySummary.success ?? daySummary["outcome:SUCCESS"] ?? 0);
  const fail = toNum(daySummary.failed ?? daySummary.fail ?? daySummary["outcome:FAIL"] ?? 0);
  acc.success += success;
  acc.fail += fail;

  for (const [k, v] of Object.entries(daySummary)) {
    if (typeof k === "string" && k.startsWith("skip:")) {
      const reason = k.slice("skip:".length);
      acc.skipByReason[reason] = (acc.skipByReason[reason] || 0) + toNum(v);
    }
  }

  const at = typeof daySummary.lastRunAt === "string" ? daySummary.lastRunAt : null;
  if (at && (!acc.lastRunAt || at > acc.lastRunAt)) {
    acc.lastRunAt = at;
    acc.lastOutcome = typeof daySummary.lastOutcome === "string" ? daySummary.lastOutcome : null;
    acc.lastReason = typeof daySummary.lastReason === "string" ? daySummary.lastReason : null;
    acc.lastSource = typeof daySummary.lastSource === "string" ? daySummary.lastSource : null;
    acc.lastRunId = typeof daySummary.lastRunId === "string" ? daySummary.lastRunId : null;
  }

  return acc;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const debug = String(url.searchParams.get("debug") || "") === "1";
  const requestedEtDate = String(url.searchParams.get("etDate") || "").trim();

  const today = requestedEtDate || getEtDateString();
  const wtdStart = startOfWeekET(today);
  const mtdStart = startOfMonth(today);
  const ytdStart = startOfYear(today);

  const periods = [
    ["today", today, today],
    ["wtd", wtdStart, today],
    ["mtd", mtdStart, today],
    ["ytd", ytdStart, today],
  ] as const;

  const out: any = {
    ok: true,
    etDateUsed: today,
    periods: {} as Record<string, any>,
  };

  for (const [name, start, end] of periods) {
    const dates = dateRange(start, end);
    let acc = emptyBucket(start, end);
    const days: any[] = [];

    for (const d of dates) {
      const r = await readAutoEntryTelemetry(d, 0, false);
      const sum = r?.summary || {};
      acc = mergeBucket(acc, sum);
      if (debug) days.push({ etDate: d, summary: sum });
    }

    out.periods[name] = acc;
    if (debug) out.periods[name].days = days;
  }

  out.dayTotals = out.periods.today;

  return NextResponse.json(out, { status: 200 });
}
