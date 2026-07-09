import { createHash } from "crypto";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2012-\u2015]/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function normalizedText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u2012-\u2015]/g, "-")
    .replace(/\b(critical|high|medium|low)\s*:\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mapKnownRootCause(text: string): string | null {
  const t = normalizedText(text);

  if (
    /negative\s+average\s+r/.test(t) ||
    /risk\s+breach/.test(t) ||
    /realized\s+r\s+below\s*-?2r/.test(t)
  ) {
    return "r-performance-negative-r";
  }

  if (/fresh\s+qualified\s+signals?\s+not\s+seeded/.test(t) || /qualified\s+not\s+seeded/.test(t)) {
    return "fresh-qualified-not-seeded";
  }

  if (/reduce\s+qualified\s+to\s+execute\s+latency/.test(t) || /execution\s+latency/.test(t)) {
    return "execution-latency";
  }

  if (/improve\s+seeded\s+to\s+executed\s+conversion/.test(t) || /seeded\s+to\s+executed/.test(t)) {
    return "seeded-executed-conversion";
  }

  if (/eliminate\s+stale\s+signal\s+drag/.test(t) || /stale\s+signal/.test(t)) {
    return "stale-signal-drag";
  }

  if (/increase\s+scoring\s+throughput\s+reliability/.test(t) || /scoring\s+throughput/.test(t)) {
    return "scoring-throughput";
  }

  if (/funnel\s+stage\s+mismatch/.test(t)) {
    return "funnel-stage-mismatch";
  }

  return null;
}

export function normalizeAgentIssueKey(input: string): string {
  const known = mapKnownRootCause(input);
  if (known) return `agent-root:${known}`;

  const normalized = normalizedText(input)
    .replace(/\b(detected|review|investigate|fix|improve|reduce|critical)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const slug = slugify(normalized || input);
  return `agent-root:${slug || "unknown"}`;
}

export function buildAgentOpportunityDedupeKey(rootCauseKey: string): string {
  return `agent-opportunity:${rootCauseKey}`;
}

export function buildStableEvidenceHash(payload: Record<string, unknown>): string {
  const stableJson = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(stableJson).digest("hex").slice(0, 24);
}

export function rootCausePriorityLane(rootCauseKey: string, title?: string): number {
  const text = `${rootCauseKey} ${title ?? ""}`.toLowerCase();
  if (/execution-latency|seeded-executed-conversion|fresh-qualified-not-seeded|stale-signal-drag/.test(text)) return 1;
  if (/protection|broker|integrity|funnel-stage-mismatch/.test(text)) return 2;
  if (/scoring-throughput|throughput/.test(text)) return 3;
  if (/r-performance-negative-r|expectancy|avg-r|realized-r/.test(text)) return 4;
  if (/ui|cleanup/.test(text)) return 7;
  return 6;
}
