"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HomeIcon, LineChartIcon, BarChart3Icon, SettingsIcon, type LucideProps } from "lucide-react";
import React from "react";

type TabDef = {
  href: string;
  label: string;
  Icon: React.ComponentType<LucideProps>;
};

const TABS: TabDef[] = [
  { href: "/today", label: "Home", Icon: HomeIcon },
  { href: "/trades", label: "Trades", Icon: LineChartIcon },
  { href: "/performance", label: "Performance", Icon: BarChart3Icon },
  { href: "/settings", label: "Settings", Icon: SettingsIcon },
];

export function BottomNav() {
  const pathname = usePathname();
  const activeHref = pathname?.startsWith("/today")
    ? "/today"
    : pathname?.startsWith("/trades")
    ? "/trades"
    : pathname?.startsWith("/performance")
    ? "/performance"
    : pathname?.startsWith("/settings")
    ? "/settings"
    : "";

  return (
    <nav className="bottom-nav" role="navigation" aria-label="Primary">
      <div className="bottom-nav-inner">
        {TABS.map(({ href, label, Icon }) => {
          const active = activeHref === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`bottom-nav-tab ${active ? "is-active" : ""}`}
            >
              <Icon className="bottom-nav-icon" size={20} />
              <span className="bottom-nav-label">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
