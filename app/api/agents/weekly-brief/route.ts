import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const weeklyBrief = await prisma.weeklyBrief.findFirst({
    orderBy: { weekOf: "desc" },
    include: { actionItems: { orderBy: { priority: "asc" }, include: { account: true } } },
  });

  if (!weeklyBrief) {
    return NextResponse.json({ weeklyBrief: null });
  }

  return NextResponse.json({ weeklyBrief });
}
