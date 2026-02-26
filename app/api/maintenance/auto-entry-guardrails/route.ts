import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import * as guardrailsStore from "@/lib/autoEntry/guardrailsStore";
import { getEtDateString } from "@/lib/time/etDate";

export const dynamic = "force-dynamic";

function isAuthorized(req: Request) {
  const autoToken = req.headers.get("x-auto-entry-token") || "";
  const cronToken = req.headers.get("x-cron-token") || "";

  const autoOk = !!process.env.AUTO_ENTRY_TOKEN && autoToken === process.env.AUTO_ENTRY_TOKEN;
  const cronOk = !!process.env.CRON_TOKEN && cronToken === process.env.CRON_TOKEN;

  return autoOk || cronOk;
}

export async function GET(req: Request) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const etDateParam = String(url.searchParams.get("etDate") || "").trim();
    const etDateUsed = etDateParam || getEtDateString();
    const redisKeyUsed = guardrailsStore.getGuardrailStateKey(etDateUsed);

    const [raw, parsed] = await Promise.all([
      redis ? redis.hgetall(redisKeyUsed) : {},
      guardrailsStore.getGuardrailsState(etDateUsed),
    ]);

    return NextResponse.json(
      {
        ok: true,
        etDateUsed,
        redisKeyUsed,
        raw: raw || {},
        parsed,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "exception", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}
