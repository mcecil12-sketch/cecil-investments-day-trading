import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import * as jsonDb from "@/lib/jsonDb";
import { NextRequest } from "next/server";

// Mock the jsonDb module
vi.mock("@/lib/jsonDb", () => ({
  readSignals: vi.fn(),
  writeSignals: vi.fn(),
}));

describe("POST /api/signals/archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should archive PENDING signals older than cutoff", async () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
    const recentDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

    const mockSignals = [
      {
        id: "1",
        ticker: "AAPL",
        side: "LONG" as const,
        entryPrice: 100,
        status: "PENDING" as const,
        createdAt: oldDate.toISOString(),
      },
      {
        id: "2",
        ticker: "GOOGL",
        side: "SHORT" as const,
        entryPrice: 200,
        status: "PENDING" as const,
        createdAt: recentDate.toISOString(),
      },
      {
        id: "3",
        ticker: "MSFT",
        side: "LONG" as const,
        entryPrice: 300,
        status: "SCORED" as const,
        createdAt: oldDate.toISOString(),
      },
    ];

    vi.mocked(jsonDb.readSignals).mockResolvedValue(mockSignals);
    vi.mocked(jsonDb.writeSignals).mockResolvedValue();

    const req = new NextRequest(
      "http://localhost:3000/api/signals/archive?status=PENDING&olderThanDays=7"
    );

    const response = await POST(req);
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.matched).toBe(1);
    expect(data.archivedCount).toBe(1);
    expect(data.statusFilter).toBe("PENDING");
    expect(jsonDb.writeSignals).toHaveBeenCalledTimes(1);

    const writtenSignals = vi.mocked(jsonDb.writeSignals).mock.calls[0][0];
    expect(writtenSignals[0].status).toBe("ARCHIVED");
    expect(writtenSignals[1].status).toBe("PENDING"); // Recent, not archived
    expect(writtenSignals[2].status).toBe("SCORED"); // Different status, not archived
  });

  it("should support olderThanHours parameter", async () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 10 * 60 * 60 * 1000); // 10 hours ago

    const mockSignals = [
      {
        id: "1",
        ticker: "AAPL",
        side: "LONG" as const,
        entryPrice: 100,
        status: "PENDING" as const,
        createdAt: oldDate.toISOString(),
      },
    ];

    vi.mocked(jsonDb.readSignals).mockResolvedValue(mockSignals);
    vi.mocked(jsonDb.writeSignals).mockResolvedValue();

    const req = new NextRequest(
      "http://localhost:3000/api/signals/archive?status=PENDING&olderThanHours=8"
    );

    const response = await POST(req);
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.archivedCount).toBe(1);
  });

  it("should support olderThanMinutes parameter with priority over hours", async () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 90 * 60 * 1000); // 90 minutes ago

    const mockSignals = [
      {
        id: "1",
        ticker: "AAPL",
        side: "LONG" as const,
        entryPrice: 100,
        status: "PENDING" as const,
        createdAt: oldDate.toISOString(),
      },
    ];

    vi.mocked(jsonDb.readSignals).mockResolvedValue(mockSignals);
    vi.mocked(jsonDb.writeSignals).mockResolvedValue();

    const req = new NextRequest(
      "http://localhost:3000/api/signals/archive?status=PENDING&olderThanMinutes=60&olderThanHours=1"
    );

    const response = await POST(req);
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.archivedCount).toBe(1);
  });

  it("should not archive signals that are already ARCHIVED", async () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

    const mockSignals = [
      {
        id: "1",
        ticker: "AAPL",
        side: "LONG" as const,
        entryPrice: 100,
        status: "ARCHIVED" as const,
        createdAt: oldDate.toISOString(),
      },
    ];

    vi.mocked(jsonDb.readSignals).mockResolvedValue(mockSignals);
    vi.mocked(jsonDb.writeSignals).mockResolvedValue();

    const req = new NextRequest(
      "http://localhost:3000/api/signals/archive?olderThanDays=7"
    );

    const response = await POST(req);
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.matched).toBe(0);
    expect(data.archivedCount).toBe(0);
  });
});
