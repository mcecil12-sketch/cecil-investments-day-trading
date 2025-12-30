import type { ReactNode } from "react";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-[var(--ci-bg)] text-[var(--ci-text)]">
      <div>{children}</div>
    </div>
  );
}
