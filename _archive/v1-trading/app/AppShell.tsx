"use client";

import type { ReactNode } from "react";
import BottomNav from "@/app/BottomNav";

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-[var(--ci-bg)] text-[var(--ci-text)]">
      <main className="ci-shell-main">{children}</main>
      <BottomNav />
    </div>
  );
}
