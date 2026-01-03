import { NextResponse } from "next/server";
import { runAutoManage } from "@/lib/autoManage/engine";

export const dynamic = "force-dynamic";

const hdr = (req: Request, k: string) => req.headers.get(k) || "";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const force = u.searchParams.get("force") === "1";
  const res = await runAutoManage({
    force,
    source: hdr(req, "x-run-source") || "unknown",
    runId: hdr(req, "x-run-id") || "",
  });
  return NextResponse.json(res);
}

export async function POST(req: Request) {
  const u = new URL(req.url);
  const force = u.searchParams.get("force") === "1";
  const res = await runAutoManage({
    force,
    source: hdr(req, "x-run-source") || "unknown",
    runId: hdr(req, "x-run-id") || "",
  });
  return NextResponse.json(res);
}
