import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function baseUrl() {
  const env = process.env.NEXT_PUBLIC_BASE_URL;
  if (env) return env.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
  return "";
}

export async function GET(req: Request) {
  const token = req.headers.get("x-cron-token") || "";
  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (process.env.PAUSE_AUTOTRADING === "1") {
    return NextResponse.json({ ok: true, skipped: true, reason: "paused" }, { status: 200 });
  }

  const url = `${baseUrl()}/api/auto-manage/run`;
  if (!url.startsWith("http")) {
    return NextResponse.json({ ok: false, error: "missing_base_url" }, { status: 500 });
  }

  const runId = `vercel-cron-auto-manage-${Date.now()}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-run-source": "vercel-cron",
      "x-run-id": runId,
    },
    body: "{}",
    cache: "no-store",
  });

  const text = await resp.text();
  try {
    return NextResponse.json({ ok: true, status: resp.status, runId, result: JSON.parse(text) }, { status: 200 });
  } catch {
    return NextResponse.json({ ok: true, status: resp.status, runId, text }, { status: 200 });
  }
}
