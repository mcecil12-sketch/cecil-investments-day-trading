export type TimeframeKey = "1W" | "2W" | "1M" | "All";

export const TIMEFRAMES: { key: TimeframeKey; label: string }[] = [
  { key: "1W", label: "1W" },
  { key: "2W", label: "2W" },
  { key: "1M", label: "1M" },
  { key: "All", label: "All" },
];

/** Trailing calendar days each timeframe covers, anchored to a series' own last date (not "today") — null means no windowing. */
export const TIMEFRAME_DAYS: Record<TimeframeKey, number | null> = {
  "1W": 7,
  "2W": 14,
  "1M": 30,
  All: null,
};
