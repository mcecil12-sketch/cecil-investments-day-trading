import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/autoEntry/telemetry", () => ({
  readAutoEntryTelemetry: vi.fn(),
}));

vi.mock("@/lib/time/etDate", () => ({
  getEtDateString: vi.fn(() => "2026-02-26"),
}));

import { readAutoEntryTelemetry } from "@/lib/autoEntry/telemetry";
import { GET } from "../route";

describe("GET /api/auto-entry/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads FAIL totals from summary.failed with backward compatibility", async () => {
    vi.mocked(readAutoEntryTelemetry).mockImplementation(async (etDate: string) => {
      if (etDate === "2026-02-26") {
        return {
          etDate,
          summary: {
            runs: 3,
            success: 1,
            failed: 2,
            skipped: 0,
            lastRunAt: "2026-02-26T13:00:00.000Z",
            lastOutcome: "FAIL",
            lastReason: "execute_error",
            lastSource: "terminal",
            lastRunId: "ae-exec-123",
          },
          runs: [],
          redis: true,
        } as any;
      }
      return { etDate, summary: {}, runs: [], redis: true } as any;
    });

    const res = await GET(new Request("http://localhost/api/auto-entry/summary?etDate=2026-02-26"));
    const body: any = await res.json();

    expect(body.ok).toBe(true);
    expect(body.periods.today.fail).toBe(2);
  });
});
