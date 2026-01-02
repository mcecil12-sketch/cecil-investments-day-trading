import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { etDateString } from "@/lib/autoEntry/guardrails";

export const dynamic = "force-dynamic";

type Summary = {
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

async function readSummaryForDate(etDate: string): Promise<any> {
  if (!redis) return null;
  const key = `autoEntry:telemetry:summary:v1:${etDate}`;
  try {
    const raw: any = await (redis as any).hgetall(key);
    const obj = raw && typeof raw === "object" && "result" in raw ? (raw as any).result : raw;
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function emptySummary(): Summary {
  return {
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

function merge(acc: Summary, day: any): Summary {
  if (!day) return acc;

  const runs = toNum(day.runs);
  const skipped = toNum(day.skipped);
  const success = toNum(day.success ?? day["outcome:SUCCESS"] ?? 0);
  const fail = toNum(day.fail ?? day["outcome:FAIL"] ?? 0);

  acc.runs += runs;
  acc.skipped += skipped;
  acc.success += success;
  acc.fail += fail;

  for (const [k, v] of Object.entries(day)) {
    if (typeof k === "string" && k.startsWith("skip:")) {
      const reason = k.slice("skip:".length);
      acc.skipByReason[reason] = (acc.skipByReason[reason] || 0) + toNum(v);
    }
  }

  const at = typeof day.lastRunAt === "string" ? day.lastRunAt : null;
  if (at && (!acc.lastRunAt || at > acc.lastRunAt)) {
    acc.lastRunAt = at;
    acc.lastOutcome = typeof day.lastOutcome === "string" ? day.lastOutcome : null;
    acc.lastReason = typeof day.lastReason === "string" ? day.lastReason : null;
    acc.lastSource = typeof day.lastSource === "string" ? day.lastSource : null;
    acc.lastRunId = typeof day.lastRunId === "string" ? day.lastRunId : null;
  }

  return acc;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const debug = String(url.searchParams.get("debug") || "") === "1";

  const today = etDateString();
  const wtdStart = startOfWeekET(today);
  const mtdStart = startOfMonth(today);
  const ytdStart = startOfYear(today);

  const periods = [
    ["today", today, today],
    ["wtd", wtdStart, today],
    ["mtd", mtdStart, today],
    ["ytd", ytdStart, today],
  ] as const;

  const out: any = { ok: true, etDate: today, periods: {} as Record<string, any> };

  for (const [name, start, end] of periods) {
    const dates = dateRange(start, end);
    let acc = emptySummary();
    const days: any[] = [];
    for (const d of dates) {
      const s = await readSummaryForDate(d);
      acc = merge(acc, s);
      if (debug) days.push({ etDate: d, summary: s });
    }
    out.periods[name] = { start, end, ...acc };
    if (debug) out.periods[name].days = days;
  }

  return NextResponse.json(out, { status: 200 });
}
