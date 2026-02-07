import { NextResponse } from "next/server";
import { readSignals } from "@/lib/jsonDb";
import { getSignalTimestampMs, parseSince, resolveSinceField } from "@/lib/signals/since";

function normalizeSignal(s: any) {
  return {
    ...s,
    reasoning: s.reasoning ?? "",
    priority: typeof s.priority === "number" ? s.priority : 4.8,
    grade: s.grade ?? s.aiGrade ?? null,
    score: s.score ?? s.totalScore ?? s.aiScore ?? null,
  };
}

function parseBool(v: string | null) {
  if (v == null) return null;
  const t = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  return null;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function normalizeStatuses(list: string[]) {
  return list
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get("since");
  const sinceFieldRaw = url.searchParams.get("sinceField");
  const onlyActiveRaw = url.searchParams.get("onlyActive");
  const orderRaw = (url.searchParams.get("order") || "").toLowerCase();
  const limitRaw = url.searchParams.get("limit");
  const statusList = url.searchParams.getAll("status");
  const statusesRaw = url.searchParams.get("statuses");

  const hasSince = Boolean(sinceRaw);
  const providedStatuses =
    statusList.length > 0 || (typeof statusesRaw === "string" && statusesRaw.trim().length > 0);
  const hasOnlyActive = onlyActiveRaw != null;

  const useDefaults = !hasSince && !providedStatuses && !hasOnlyActive;

  const sinceField = resolveSinceField(sinceFieldRaw);
  const sinceDate = useDefaults ? parseSince("48h") : parseSince(sinceRaw);
  const order = orderRaw === "asc" ? "asc" : "desc";
  const limitParsed = Number(limitRaw ?? 200);
  const limit = clamp(Number.isFinite(limitParsed) ? limitParsed : 200, 1, 1000);

  const onlyActive = useDefaults ? true : (parseBool(onlyActiveRaw) ?? false);

  const statusesApplied = useDefaults
    ? normalizeStatuses(["SCORED", "PENDING"])
    : onlyActive && !providedStatuses
    ? normalizeStatuses(["SCORED", "PENDING"])
    : normalizeStatuses([
        ...statusList,
        ...(statusesRaw ? statusesRaw.split(",") : []),
      ]);

  const signals = await readSignals();
  const normalized = signals.map(normalizeSignal);

  let filtered = normalized;
  if (sinceDate) {
    const sinceMs = sinceDate.getTime();
    filtered = filtered.filter((s: any) => {
      const t = getSignalTimestampMs(s, sinceField);
      return t != null && Number.isFinite(t) && t >= sinceMs;
    });
  }

  if (statusesApplied.length > 0) {
    const set = new Set(statusesApplied);
    filtered = filtered.filter((s: any) => set.has(String(s?.status || "").toUpperCase()));
  }

  if (onlyActive) {
    filtered = filtered.filter((s: any) => String(s?.status || "").toUpperCase() !== "ARCHIVED");
  }

  const sortedSignals = [...filtered].sort((a: any, b: any) => {
    const ta = Date.parse(a?.createdAt ?? "");
    const tb = Date.parse(b?.createdAt ?? "");
    const taOk = Number.isFinite(ta);
    const tbOk = Number.isFinite(tb);
    if (!taOk && !tbOk) return 0;
    if (!taOk) return 1;
    if (!tbOk) return -1;
    return order === "asc" ? ta - tb : tb - ta;
  });

  const totalBefore = normalized.length;
  const totalAfter = sortedSignals.length;
  const sliced = sortedSignals.slice(0, limit);
  return NextResponse.json(
    {
      ok: true,
      meta: {
        totalBefore,
        totalAfter,
        since: sinceDate ? sinceDate.toISOString() : null,
        sinceISO: sinceDate ? sinceDate.toISOString() : null,
        sinceField,
        order,
        limit,
        onlyActive,
        statusesApplied,
        statusesProvided: providedStatuses,
      },
      signals: sliced,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
