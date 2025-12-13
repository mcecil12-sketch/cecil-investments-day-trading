"use client";

import React from "react";
import { BottomNav } from "@/components/BottomNav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <main className="app-shell-content">{children}</main>
      <div className="bottom-nav">
        <BottomNav />
      </div>
    </div>
  );
}
