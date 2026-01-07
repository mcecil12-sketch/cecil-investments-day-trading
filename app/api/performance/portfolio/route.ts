import { NextResponse } from "next/server";
import { buildPortfolioSnapshot } from "@/lib/performance/portfolioSnapshot";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await buildPortfolioSnapshot();
    return NextResponse.json(payload, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to compute portfolio",
        detail: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}
