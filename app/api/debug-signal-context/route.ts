import { NextResponse } from "next/server";
import { buildSignalContext } from "@/lib/signalContext";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ticker = (url.searchParams.get("ticker") || "SPY").toUpperCase();
  const timeframe = (url.searchParams.get("timeframe") || "1Min") as any;

  try {
    const ctx = await buildSignalContext({ ticker, timeframe });

    return NextResponse.json(
      {
        ok: true,
        ticker,
        timeframe,
        ctxKeys: Object.keys(ctx || {}),
        ctx,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, ticker, timeframe, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
