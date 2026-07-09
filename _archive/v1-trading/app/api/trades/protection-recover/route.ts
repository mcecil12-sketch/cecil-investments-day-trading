import { NextResponse } from "next/server";
import { recoverUnprotectedTrades } from "@/lib/risk/protection-recover";

export const dynamic = "force-dynamic";

export async function POST() {
  const result = await recoverUnprotectedTrades();
  return NextResponse.json(result, { status: 200 });
}

export async function GET() {
  const result = await recoverUnprotectedTrades();
  return NextResponse.json(result, { status: 200 });
}
