const ET_TIME_ZONE = "America/New_York";

const datePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "shortOffset",
});

function part(parts: Intl.DateTimeFormatPart[], type: string, fallback: string) {
  return parts.find((p) => p.type === type)?.value ?? fallback;
}

export function getEtNow(): Date {
  return new Date();
}

export function getEtDateString(d: Date = getEtNow()): string {
  const parts = datePartsFormatter.formatToParts(d);
  const y = part(parts, "year", "1970");
  const m = part(parts, "month", "01");
  const day = part(parts, "day", "01");
  return `${y}-${m}-${day}`;
}

export function getEtNowIso(d: Date = getEtNow()): string {
  const parts = dateTimePartsFormatter.formatToParts(d);
  const y = part(parts, "year", "1970");
  const m = part(parts, "month", "01");
  const day = part(parts, "day", "01");
  const hh = part(parts, "hour", "00");
  const mm = part(parts, "minute", "00");
  const ss = part(parts, "second", "00");
  const tzRaw = part(parts, "timeZoneName", "GMT-05:00");
  const offset = tzRaw.replace("GMT", "") || "-05:00";
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}${offset}`;
}
