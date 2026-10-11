export function formatCurrency(value: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

/** Dollar amount with an explicit "+"/"-" sign, e.g. "+$4,532" or "-$1,204" — for gain/loss figures rather than plain balances. */
export function formatSignedCurrency(value: number | null): string {
  if (value == null) return "—";
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatCurrency(Math.abs(value))}`;
}

export function formatCompactCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPercent(value: number | null): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatDate(date: Date | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(date: Date | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Date + time in America/New_York with an explicit "ET" marker — for operational timestamps (runs, health), which are stored in UTC. */
export function formatDateTimeET(date: Date | null): string {
  if (!date) return "—";
  return `${new Date(date).toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })} ET`;
}

/** Calendar date stored as UTC midnight (e.g. a week-of date): formatted in UTC so it never slides back a day. */
export function formatCalendarDate(date: Date | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}

export function alphaColor(alpha: number | null): string | undefined {
  if (alpha == null) return undefined;
  return alpha >= 0 ? "var(--positive)" : "var(--negative)";
}
