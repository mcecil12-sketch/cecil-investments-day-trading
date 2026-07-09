import { NextRequest, NextResponse } from "next/server";
import { deleteAccount, getAccount, updateAccount } from "@/lib/portfolio/accounts";
import { AccountType } from "@/lib/generated/prisma";

const VALID_TYPES = new Set(Object.values(AccountType));

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const account = await getAccount(params.id);
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  return NextResponse.json({ account });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.type !== undefined && !VALID_TYPES.has(body.type)) {
    return NextResponse.json(
      { error: `type must be one of: ${Array.from(VALID_TYPES).join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const account = await updateAccount(params.id, {
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      type: body.type,
      institution: typeof body.institution === "string" ? body.institution.trim() : undefined,
      externalId: body.externalId === null ? null : body.externalId,
      isLocked: typeof body.isLocked === "boolean" ? body.isLocked : undefined,
    });
    return NextResponse.json({ account });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    await deleteAccount(params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
