import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    ALPACA_TRADING_BASE_URL: process.env.ALPACA_TRADING_BASE_URL || null,
    hasAlpacaKey: Boolean(process.env.ALPACA_API_KEY_ID || process.env.ALPACA_API_KEY),
    hasAlpacaSecret: Boolean(process.env.ALPACA_API_SECRET || process.env.ALPACA_API_SECRET_KEY),
    OPENAI_MODEL_BULK: process.env.OPENAI_MODEL_BULK ?? null,
    OPENAI_MODEL_HEAVY: process.env.OPENAI_MODEL_HEAVY ?? null,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    timestamp: new Date().toISOString(),
  });
}
