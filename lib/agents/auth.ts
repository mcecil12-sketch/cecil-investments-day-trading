import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

export function getAgentCronToken(req: Request): string {
  return req.headers.get("x-cron-token") || "";
}

export function checkAgentCronAuth(req: Request): { ok: true } | { ok: false; error: string } {
  const token = getAgentCronToken(req);
  const expected = process.env.CRON_TOKEN || process.env.CRON_SECRET || "";

  if (!expected) {
    return { ok: false, error: "CRON_TOKEN not configured" };
  }

  if (token !== expected) {
    return { ok: false, error: "unauthorized" };
  }

  return { ok: true };
}

export function unauthorizedAgentResponse(error: string) {
  return NextResponse.json(
    {
      ok: false,
      error,
      message: error === "unauthorized" ? "Missing or invalid x-cron-token" : error,
    },
    { status: 401 }
  );
}

export async function checkAgentReadAuth(
  req: Request
): Promise<{ ok: true; authMode: "cron_token" | "app_pin" } | { ok: false; error: string }> {
  const cronAuth = checkAgentCronAuth(req);
  if (cronAuth.ok) {
    return { ok: true, authMode: "cron_token" };
  }

  const auth = await requireAuth(req);
  if (auth.ok) {
    return { ok: true, authMode: "app_pin" };
  }

  return { ok: false, error: "unauthorized" };
}