import { NextRequest, NextResponse } from "next/server";

// In-memory store for now (resets on server restart)
let pendingSignals: any[] = [];

export async function POST(req: NextRequest) {
  const body = await req.json();

  const signal = {
    id: Date.now(),
    symbol: body.symbol ?? "UNKNOWN",
    side: body.side ?? "LONG",
    timeframe: body.timeframe ?? "5m",
    entry: body.entry?.toString() ?? "",
    stop: body.stop?.toString() ?? "",
    source: body.source ?? "unknown",
    receivedAt: new Date().toISOString(),
    status: "PENDING",
  };

  pendingSignals.push(signal);

  return NextResponse.json({ ok: true, signal });
}

// Simple debug endpoint to inspect signals
export async function GET() {
  return NextResponse.json({ pendingSignals });
}
