"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function BottomNav() {
  const pathname = usePathname();

  const items = [
    {
      href: "/today",
      label: "Home",
      icon: (
        <svg
          width="20"
          height="20"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M3 4h18v2H3V4zm0 7h18v2H3v-2zm0 7h18v2H3v-2z" />
        </svg>
      ),
    },
    {
      href: "/trades",
      label: "Trades",
      icon: (
        <svg
          width="20"
          height="20"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M4 7h16v2H4V7zm0 5h10v2H4v-2zm0 5h7v2H4v-2z" />
        </svg>
      ),
    },
    {
      href: "/performance",
      label: "Stats",
      icon: (
        <svg
          width="20"
          height="20"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M5 14h3v6H5v-6zm6-4h3v10h-3V10zm6-7h3v17h-3V3z" />
        </svg>
      ),
    },
    {
      href: "/settings",
      label: "Settings",
      icon: (
        <svg
          width="20"
          height="20"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M19.14 12.936a7.993 7.993 0 000-1.872l2.037-1.58a.5.5 0 00.121-.638l-1.928-3.338a.5.5 0 00-.607-.22l-2.397.96a7.994 7.994 0 00-1.62-.936l-.36-2.54a.5.5 0 00-.497-.42H9.09a.5.5 0 00-.497.42l-.36 2.54a8.053 8.053 0 00-1.62.936l-2.397-.96a.5.5 0 00-.607.22L2.182 8.846a.5.5 0 00.121.638l2.037 1.58a7.993 7.993 0 000 1.872l-2.037 1.58a.5.5 0 00-.121.638l1.928 3.338c.14.243.44.34.607.22l2.397-.96c.5.39 1.04.71 1.62.936l.36 2.54a.5.5 0 00.497.42h3.82a.5.5 0 00.497-.42l.36-2.54a7.994 7.994 0 001.62-.936l2.397.96c.167.12.468.023.607-.22l1.928-3.338a.5.5 0 00-.121-.638l-2.037-1.58zM12 15.2a3.2 3.2 0 110-6.4 3.2 3.2 0 010 6.4z" />
        </svg>
      ),
    },
  ];

  return (
    <nav className="bottom-nav">
      {items.map((item) => {
        const isActive = pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-item ${isActive ? "active" : ""}`}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
