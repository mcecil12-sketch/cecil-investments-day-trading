import { describe, expect, it } from "vitest";
import { dropUnsettledSessionBar, isTodaySessionUnsettled, lastSettledSessionKey, nyDateKey } from "@/lib/market/session";

// Oct 19, 2026 is a Monday; New York is on EDT (UTC-4).
const mon2pm = new Date("2026-10-19T18:00:00Z");
const mon5pm = new Date("2026-10-19T21:00:00Z");
const mon8am = new Date("2026-10-19T12:00:00Z");
const sat = new Date("2026-10-17T16:00:00Z");

const bar = (iso: string, close: number) => ({ date: new Date(iso), close });
// Yahoo daily bars are timestamped at the session open (9:30am ET = 13:30Z).
const bars = [bar("2026-10-15T13:30:00Z", 100), bar("2026-10-16T13:30:00Z", 101), bar("2026-10-19T13:30:00Z", 99)];

describe("market session helpers", () => {
  it("treats a weekday before 4:15pm ET as unsettled", () => {
    expect(isTodaySessionUnsettled(mon2pm)).toBe(true);
    expect(isTodaySessionUnsettled(mon5pm)).toBe(false);
    expect(isTodaySessionUnsettled(sat)).toBe(false);
  });

  it("finds the last settled session", () => {
    expect(lastSettledSessionKey(mon2pm)).toBe("2026-10-16");
    expect(lastSettledSessionKey(mon8am)).toBe("2026-10-16");
    expect(lastSettledSessionKey(mon5pm)).toBe("2026-10-19");
    expect(lastSettledSessionKey(sat)).toBe("2026-10-16");
  });

  it("drops today's partial bar only while the session is unsettled", () => {
    expect(dropUnsettledSessionBar(bars, mon2pm).map((b) => b.close)).toEqual([100, 101]);
    expect(dropUnsettledSessionBar(bars, mon5pm).map((b) => b.close)).toEqual([100, 101, 99]);
    expect(dropUnsettledSessionBar(bars.slice(0, 2), mon2pm).map((b) => b.close)).toEqual([100, 101]);
  });

  it("keys instants by their New York date", () => {
    expect(nyDateKey(new Date("2026-10-20T02:00:00Z"))).toBe("2026-10-19");
  });
});
