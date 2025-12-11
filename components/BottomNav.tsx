"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  HomeIcon,
  BarChart3Icon,
  LineChartIcon,
  SettingsIcon,
} from "lucide-react";
import React from "react";

export function BottomNav() {
  const pathname = usePathname();

  const tab = (href: string, label: string, icon: React.ReactNode) => {
    const active = pathname === href;
    return (
      <Link
        key={href}
        href={href}
        className={`flex flex-col items-center justify-center flex-1 py-1 ${
          active ? "text-[var(--ci-accent)]" : "text-[var(--ci-text-muted)]"
        }`}
      >
        <div className="mb-1 flex items-center justify-center">{icon}</div>
        <span className="text-[10px] font-medium tracking-wide">{label}</span>
      </Link>
    );
  };

  return (
    <nav className="bottom-nav fixed bottom-0 left-0 right-0 h-14 bg-[var(--ci-bg-elevated)] border-t border-[var(--ci-border)] shadow-[0_-4px_12px_rgba(0,0,0,0.6)] backdrop-blur-md z-50">
      <div className="bottom-nav-inner mx-auto flex w-full max-w-5xl items-center justify-evenly gap-2 px-4">
        {tab("/today", "Today", <HomeIcon size={18} />)}
        {tab("/trades", "Trades", <LineChartIcon size={18} />)}
        {tab("/performance", "Performance", <BarChart3Icon size={18} />)}
        {tab("/settings", "Settings", <SettingsIcon size={18} />)}
      </div>
    </nav>
  );
}
