"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  HomeIcon,
  LineChartIcon,
  BarChart3Icon,
  SettingsIcon,
} from "lucide-react";
import React from "react";

type TabConfig = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
};

const TABS: TabConfig[] = [
  { href: "/today", label: "Today", icon: HomeIcon },
  { href: "/trades", label: "Trades", icon: LineChartIcon },
  { href: "/performance", label: "Performance", icon: BarChart3Icon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="
        fixed inset-x-0 bottom-0 z-50
        border-t border-[var(--ci-border)]
        bg-[var(--ci-card)]/96
        backdrop-blur-lg
        shadow-[0_-12px_20px_rgba(2,6,23,0.55)]
      "
    >
      <div
        className="
          mx-auto max-w-4xl
          flex items-center justify-around
          px-4 py-3
        "
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 6px)" }}
      >
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;

          return (
            <Link
              key={href}
              href={href}
              className={`
                flex flex-col items-center justify-center
                gap-1
                text-[12px] font-semibold tracking-wide
                transition-colors
                ${active
                  ? "text-[var(--ci-accent)]"
                  : "text-[var(--ci-text-muted)]"}
              `}
            >
              <Icon size={20} strokeWidth={1.6} />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
