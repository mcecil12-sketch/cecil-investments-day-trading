import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { TradingProvider } from "./tradingContext";
import { AutoManagePoller } from "@/components/AutoManagePoller";

export const metadata: Metadata = {
  title: "Cecil Investments · Trading Desk",
  description: "Intraday trading · R-based risk · Alpaca paper",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body className="app-root">
        <TradingProvider>
          <AutoManagePoller />
          <div className="app-shell">
            <main className="app-main">{children}</main>
          </div>
        </TradingProvider>
      </body>
    </html>
  );
}
