import { NextResponse } from "next/server";

const APP_PIN = process.env.APP_PIN;

if (!APP_PIN) {
  console.warn("[/api/login] APP_PIN is not set. Login will always fail.");
}

type LoginBody = {
  pin?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as LoginBody;
    const pin = (body.pin || "").trim();

    if (!APP_PIN) {
      return NextResponse.json(
        { ok: false, error: "Server PIN not configured." },
        { status: 500 }
      );
    }

    if (!pin) {
      return NextResponse.json(
        { ok: false, error: "PIN is required." },
        { status: 400 }
      );
    }

    if (pin !== APP_PIN) {
      return NextResponse.json(
        { ok: false, error: "Invalid PIN." },
        { status: 401 }
      );
    }

    // Success: issue a simple auth cookie.
    const res = NextResponse.json({ ok: true });
    res.cookies.set("auth_pin", "1", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 12, // 12 hours
    });

    return res;
  } catch (err) {
    console.error("[/api/login] POST error:", err);
    return NextResponse.json(
      { ok: false, error: "Login failed." },
      { status: 500 }
    );
  }
}
