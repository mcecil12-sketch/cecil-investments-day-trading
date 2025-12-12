import type { ReactNode } from "react";
import { BottomNav } from "@/components/BottomNav";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-[var(--ci-bg)] text-[var(--ci-text)]">
      {/* Content area gets bottom padding so it never hides behind fixed nav */}
      <div className="pb-[calc(72px+env(safe-area-inset-bottom))]">
        {children}
      </div>

      {/* Single global nav - fixed and persistent */}
      <BottomNav />
    </div>
  );
}
