import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { readSignals, writeSignals, StoredSignal } from "@/lib/jsonDb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RepairMode = "mark-error" | "archive";

type RepairBody = {
  mode?: RepairMode;
  limit?: number;
};

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: RepairBody = {};
  try {
    body = (await req.json()) as RepairBody;
  } catch {
    // ignore
  }

  const mode: RepairMode = body.mode ?? "mark-error";
  const limit = Math.max(1, Number(body.limit ?? 200));

  const signals = await readSignals();
  const nowIso = new Date().toISOString();
  let fixed = 0;
  const sample: Array<{ id: string; ticker: string; createdAt: string }> = [];

  type RepairSignal = StoredSignal & {
    updatedAt?: string;
    archived?: boolean;
    archivedAt?: string;
  };

  const repaired = signals.map((signal) => {
    if (fixed >= limit) return signal;
    if (signal.status !== "SCORED") return signal;
    const missingScore = signal.score == null;
    const missingGrade = signal.grade == null;
    if (!missingScore && !missingGrade) return signal;

    if (sample.length < limit) {
      sample.push({ id: signal.id, ticker: signal.ticker, createdAt: signal.createdAt });
    }

    fixed += 1;
    const base: RepairSignal = { ...signal, updatedAt: nowIso };

    if (mode === "archive") {
      return { ...base, archived: true, archivedAt: nowIso };
    }

    return {
      ...base,
      status: "ERROR",
      error: "legacy_scored_missing_fields",
    };
  });

  if (fixed) {
    await writeSignals(repaired);
  }

  return NextResponse.json({
    ok: true,
    scanned: signals.length,
    fixed,
    mode,
    sample,
  });
}
