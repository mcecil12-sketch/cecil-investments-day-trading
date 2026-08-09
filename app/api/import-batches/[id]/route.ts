import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deleteImportBatch } from "@/lib/portfolio/import";

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const batch = await prisma.importBatch.findUnique({ where: { id: params.id } });
  if (!batch) {
    return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
  }

  await deleteImportBatch(params.id);
  return NextResponse.json({ ok: true });
}
