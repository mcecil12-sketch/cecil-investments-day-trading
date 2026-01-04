import { getTradingDayKey } from "@/lib/tradingDay";

export function nowIso() {
  return new Date().toISOString();
}

export function nowETDate(): string {
  return getTradingDayKey();
}

export function etParts(tsIso?: string) {
  const d = tsIso ? new Date(tsIso) : new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(d).reduce((acc: any, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});

  const dateET = `${parts.year}-${parts.month}-${parts.day}`;
  const hh = Number(parts.hour);
  const mm = Number(parts.minute);
  const ss = Number(parts.second);
  const hhmm = hh * 100 + mm;

  return { dateET, hh, mm, ss, hhmm };
}

export function bucketET(hhmm: number): "open" | "mid" | "power" | "after" {
  if (hhmm < 930) return "after";
  if (hhmm <= 1045) return "open";
  if (hhmm <= 1430) return "mid";
  if (hhmm <= 1600) return "power";
  return "after";
}
