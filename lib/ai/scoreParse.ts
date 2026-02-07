export type ParsedScore = {
  score: number;
  grade: string;
  summary: string;
  qualified?: boolean;
  reasons?: string[];
  reasoning?: string;
  rawJson?: any;
};

function stripFences(s: string): string {
  const t = (s || "").trim();
  if (!t) return "";
  return t.replace(/^```[a-zA-Z0-9_-]*\s*/m, "").replace(/```$/m, "").trim();
}

function extractFirstJsonObject(s: string): string | null {
  const text = s || "";
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function clampScore(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 10) return 10;
  return Math.round(x * 10) / 10;
}

function normalizeGrade(g: any): string {
  const s = String(g || "").trim().toUpperCase();
  const m = s.match(/^[A-F]$/);
  return m ? m[0] : "F";
}

function heuristicParse(text: string): ParsedScore | null {
  const t = (text || "").trim();
  if (!t) return null;

  let score: number | null = null;
  const m1 = t.match(/Scored\s+([A-F])\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*\)/i);
  if (m1) score = parseFloat(m1[2]);
  if (score == null) {
    const m2 = t.match(/\b(?:aiScore|score)\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (m2) score = parseFloat(m2[1]);
  }

  let grade = "F";
  const g1 = t.match(/\b(?:aiGrade|grade)\s*[:=]\s*([A-F])\b/i);
  if (g1) grade = g1[1].toUpperCase();
  else if (m1) grade = m1[1].toUpperCase();

  let summary = t.replace(/^Scored\s+[A-F]\s*\(\s*[0-9]+(?:\.[0-9]+)?\s*\)\.?\s*/i, "").trim();
  if (!summary) summary = t.slice(0, 500).trim();

  if (score == null) return null;
  return { score: clampScore(score), grade: normalizeGrade(grade), summary };
}

export function parseAiScoreOutput(
  raw: string
): { ok: true; parsed: ParsedScore } | { ok: false; reason: string; rawHead: string } {
  const rawHead = (raw || "").trim().slice(0, 800);
  const cleaned = stripFences(raw || "");
  if (!cleaned) return { ok: false, reason: "empty_response", rawHead };

  const jsonStr = extractFirstJsonObject(cleaned);
  if (jsonStr) {
    try {
      const obj = JSON.parse(jsonStr);
      const score = clampScore(Number(obj.score ?? obj.aiScore));
      const grade = normalizeGrade(obj.grade ?? obj.aiGrade);
      const summary = String(obj.summary ?? obj.aiSummary ?? "").trim();
      const qualified = typeof obj.qualified === "boolean" ? obj.qualified : undefined;
      const reasons = Array.isArray(obj.reasons)
        ? obj.reasons.map((r: any) => String(r)).filter((r: string) => r.trim().length > 0)
        : undefined;
      const reasoning = obj.reasoning ? String(obj.reasoning) : undefined;

      if (Number.isFinite(score) && summary) {
        return {
          ok: true,
          parsed: { score, grade, summary, qualified, reasons, reasoning, rawJson: obj },
        };
      }
    } catch {
      // fall through to heuristic
    }
  }

  const h = heuristicParse(cleaned);
  if (h) return { ok: true, parsed: h };

  return { ok: false, reason: "unparseable", rawHead };
}
