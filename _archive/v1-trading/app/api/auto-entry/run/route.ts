
import { NextResponse } from "next/server";
import { runAutoEntryOnce } from "@/lib/autoEntry/engine";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const res = await runAutoEntryOnce(req);
  const status =
    (res as any)?.status ??
    ((res as any)?.ok === false ? 400 : 200);
  return NextResponse.json(res, { status });
}
