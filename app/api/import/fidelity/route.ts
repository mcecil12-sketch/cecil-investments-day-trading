import { NextRequest, NextResponse } from "next/server";
import { importFidelityCsv } from "@/lib/portfolio/import";
import { triggerRelativeStrengthRun } from "@/lib/agents/runner";

export async function POST(request: NextRequest) {
  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' in form data" }, { status: 400 });
  }

  const csvText = await file.text();
  if (!csvText.trim()) {
    return NextResponse.json({ error: "Uploaded file is empty" }, { status: 400 });
  }

  const result = await importFidelityCsv({ csvText, fileName: file.name });

  if (result.batches.some((batch) => batch.status === "COMPLETE")) {
    triggerRelativeStrengthRun();
  }

  return NextResponse.json(result, { status: 201 });
}
