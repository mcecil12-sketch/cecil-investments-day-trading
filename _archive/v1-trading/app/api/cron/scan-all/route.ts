import { NextResponse } from "next/server";

const MODES = ["pullback", "breakout", "compression", "premarket"] as const;

function getBaseUrl() {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  return "http://localhost:3000";
}

export async function GET() {
  const baseUrl = getBaseUrl();

  const results: any[] = [];

  for (const mode of MODES) {
    const url = `${baseUrl}/api/scan?mode=${mode}&minPrice=10&minVolume=2000000&limit=300`;

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
        cache: "no-store",
      });

      const json = await res.json().catch(() => ({}));
      results.push({
        mode,
        ok: res.ok,
        status: res.status,
        body: json,
      });
    } catch (err: any) {
      results.push({
        mode,
        ok: false,
        error: err?.message ?? "Unknown error",
      });
    }
  }

  return NextResponse.json({
    status: "ok",
    ran: MODES,
    results,
  });
}
