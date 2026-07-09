import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

const dataDir = path.join(process.cwd(), "data");

export async function POST() {
  try {
    const tradesPath = path.join(dataDir, "trades.json");
    const signalsPath = path.join(dataDir, "signals.json");

    await fs.writeFile(tradesPath, "[]", "utf8");
    await fs.writeFile(signalsPath, "[]", "utf8");

    return NextResponse.json({ ok: true, message: "All trades and signals reset." });
  } catch (err) {
    console.error("Reset error:", err);
    return NextResponse.json({ ok: false, error: "Failed to reset data." }, { status: 500 });
  }
}
