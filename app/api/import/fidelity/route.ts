import { NextRequest, NextResponse } from "next/server";
import { importFidelityCsv } from "@/lib/portfolio/import";

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
  return NextResponse.json(result, { status: 201 });
}
