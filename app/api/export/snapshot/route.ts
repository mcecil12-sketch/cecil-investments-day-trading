import { NextResponse } from "next/server";
import { loadSnapshotData } from "@/lib/export/snapshotData";
import { buildSnapshotMarkdown, snapshotFilename } from "@/lib/export/snapshotMarkdown";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Sits behind the app-wide PIN gate (middleware.ts) — no separate auth here. */
export async function GET() {
  const now = new Date();
  const data = await loadSnapshotData(now);
  return new NextResponse(buildSnapshotMarkdown(data), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${snapshotFilename(now)}"`,
      "Cache-Control": "no-store",
    },
  });
}
