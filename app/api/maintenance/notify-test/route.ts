import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { NotificationEvent, NotificationEventType } from "@/lib/notifications/types";
import { notify } from "@/lib/notifications/notify";
import { shouldSendNotification } from "@/lib/notifications/dedupe";

const VALID_TYPES: NotificationEventType[] = [
  "AUTO_ENTRY_PLACED",
  "AUTO_ENTRY_FAILED",
  "AUTO_ENTRY_DISABLED",
  "TRADE_CLOSED",
  "STOP_HIT",
  "APPROVAL_REQUIRED",
  "SIGNAL_APPROVAL",
  "PULLBACK_READY",
];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    const token = req.headers.get("x-cron-token") || "";
  
  const authedByCron = Boolean(process.env.CRON_TOKEN) && token === process.env.CRON_TOKEN;
if (!authedByCron) {
    
  }

const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Partial<{
    title: string;
    message: string;
    paper: boolean;
    tier: "A" | "B" | "C";
    tradeId: string;
    ticker: string;
    type: string;
    dedupeKey: string;
    dedupeTtlSec: number;
  }> = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {}

  const dedupeKey = body.dedupeKey ? String(body.dedupeKey) : null;
  const dedupeTtl = Number(body.dedupeTtlSec ?? 3600);
  if (dedupeKey) {
    const allowed = await shouldSendNotification(dedupeKey, dedupeTtl);
    if (!allowed) {
      return NextResponse.json(
        { ok: true, sent: false, skippedReason: "dedupe" },
        { status: 200 }
      );
    }
  }

  const requestedType = (body.type ?? "AUTO_ENTRY_FAILED").toUpperCase();
  const type: NotificationEventType = VALID_TYPES.includes(
    requestedType as NotificationEventType
  )
    ? (requestedType as NotificationEventType)
    : "AUTO_ENTRY_FAILED";

  const event: NotificationEvent = {
    type,
    title: body.title ? String(body.title) : `${type} notification`,
    message: body.message ? String(body.message) : "",
    paper: Boolean(body.paper),
    tier: body.tier,
    tradeId: body.tradeId ? String(body.tradeId) : undefined,
    ticker: body.ticker ? String(body.ticker) : undefined,
    dedupeKey: dedupeKey ?? undefined,
    dedupeTtlSec: dedupeKey ? dedupeTtl : undefined,
    skipDedupe: true,
    meta: {
      manual: true,
    },
  };

  const result = await notify(event);
  return NextResponse.json({ ok: true, result }, { status: 200 });
}
