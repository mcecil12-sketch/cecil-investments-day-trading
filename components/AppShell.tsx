"use client";

import React from "react";
import { BottomNav } from "@/components/BottomNav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-black text-white">
      <main className="pb-24">{children}</main>
      <BottomNav />
    </div>
  );
}
