"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  href: string;
  label: string;
  icon?: React.ReactNode;
};

const items: NavItem[] = [
  { href: "/today", label: "Today" },
  { href: "/trades", label: "Trades" },
  { href: "/performance", label: "Stats" },
  { href: "/settings", label: "Settings" },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="bottom-nav">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`bottom-nav-item ${active ? "active" : ""}`}
          >
            {/* Simple dot indicator; swap for icons later if you like */}
            <div style={{ fontSize: 16, lineHeight: 1 }}>
              {active ? "●" : "○"}
            </div>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
