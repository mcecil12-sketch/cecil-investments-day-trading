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

  const base = baseUrl();
  const executeUrl = `${base}/api/auto-entry/execute`;
  const seedUrl = `${base}/api/auto-entry/seed-from-signals?limit=3&minScore=7.5`;
  if (!executeUrl.startsWith("http") || !seedUrl.startsWith("http")) {
    return NextResponse.json({ ok: false, error: "missing_base_url" }, { status: 500 });
  }

  const runId = `vercel-cron-auto-entry-${Date.now()}`;

  const seedResp = await fetch(seedUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-token": process.env.CRON_TOKEN || "",
      "x-run-source": "vercel-cron",
      "x-run-id": runId,
    },
    body: "{}",
    cache: "no-store",
  });

  const seedText = await seedResp.text();
  let seedResult: any = seedText;
  try {
    seedResult = JSON.parse(seedText);
  } catch {}

  const resp = await fetch(executeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auto-entry-token": process.env.AUTO_ENTRY_TOKEN || "",
      "x-run-source": "vercel-cron",
      "x-run-id": runId,
    },
    body: "{}",
    cache: "no-store",
  });

  const text = await resp.text();
  try {
    return NextResponse.json(
      {
        ok: true,
        runId,
        seedStatus: seedResp.status,
        seedResult,
        executeStatus: resp.status,
        executeResult: JSON.parse(text),
      },
      { status: 200 }
    );
  } catch {
    return NextResponse.json(
      {
        ok: true,
        runId,
        seedStatus: seedResp.status,
        seedResult,
        executeStatus: resp.status,
        text,
      },
      { status: 200 }
    );
  }
}
