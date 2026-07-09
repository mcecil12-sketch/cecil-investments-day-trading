import { NextRequest, NextResponse } from "next/server";
import { createAccount, listAccounts } from "@/lib/portfolio/accounts";
import { AccountType } from "@/lib/generated/prisma";

const VALID_TYPES = new Set(Object.values(AccountType));

export async function GET() {
  const accounts = await listAccounts();
  return NextResponse.json({ accounts });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (typeof body.type !== "string" || !VALID_TYPES.has(body.type)) {
    return NextResponse.json(
      { error: `type must be one of: ${Array.from(VALID_TYPES).join(", ")}` },
      { status: 400 },
    );
  }
  if (typeof body.institution !== "string" || !body.institution.trim()) {
    return NextResponse.json({ error: "institution is required" }, { status: 400 });
  }

  try {
    const account = await createAccount({
      name: body.name.trim(),
      type: body.type,
      institution: body.institution.trim(),
      externalId: typeof body.externalId === "string" ? body.externalId.trim() : null,
      isLocked: Boolean(body.isLocked),
    });
    return NextResponse.json({ account }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
