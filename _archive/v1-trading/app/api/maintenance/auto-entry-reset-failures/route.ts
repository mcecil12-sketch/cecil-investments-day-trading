import { NextResponse } from "next/server";
import * as guardrailsStore from "@/lib/autoEntry/guardrailsStore";
import { getEtDateString } from "@/lib/time/etDate";

export const dynamic = "force-dynamic";

function isAuthorized(req: Request) {
  const token = req.headers.get("x-cron-token") || "";
  return Boolean(process.env.CRON_TOKEN) && token === process.env.CRON_TOKEN;
}

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const dateET = String(body.dateET || getEtDateString());
    const reason = String(body.reason || "manual_reset");

    await guardrailsStore.resetFailures(dateET);

    const state = await guardrailsStore.getGuardrailsState(dateET);

    return NextResponse.json({
      ok: true,
      dateET,
      reason,
      guardState: {
        consecutiveFailures: state.consecutiveFailures,
        autoDisabledReason: state.autoDisabledReason,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "exception", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
