import "./globals.css";
import { TradingProvider } from "./tradingContext";
import HeaderStats from "./headerstats";
import BottomNav from "./BottomNav";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cecil Investments – Day Trading Assistant",
  description: "R-based intraday risk management and trade journaling",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[var(--ci-bg)] text-[var(--ci-text)]">
        <TradingProvider>
          <div className="min-h-screen flex flex-col">
            <header className="border-b border-[var(--ci-border)] bg-[var(--ci-bg)]">
              <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold tracking-tight">
                    Cecil Investments · Trading Desk
                  </div>
                  <div className="text-[var(--ci-text-muted)] text-xs">
                    Intraday trading · R-based risk · Alpaca paper
                  </div>
                </div>
                <nav className="hidden md:flex items-center gap-4 text-xs text-[var(--ci-text-muted)]">
                  <Link href="/today" className="hover:text-[var(--ci-text)]">
                    Today
                  </Link>
                  <Link href="/trades" className="hover:text-[var(--ci-text)]">
                    Trades
                  </Link>
                  <Link href="/playbook" className="hover:text-[var(--ci-text)]">
                    Playbook
                  </Link>
                  <Link href="/activity" className="hover:text-[var(--ci-text)]">
                    Activity
                  </Link>
                </nav>
                <div className="hidden md:block">
                  <HeaderStats />
                </div>
              </div>
            </header>

            <main className="flex-1">{children}</main>

            <BottomNav />
          </div>
        </TradingProvider>
      </body>
    </html>
  );
}
