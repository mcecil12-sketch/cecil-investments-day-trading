import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { TradingProvider } from "./tradingContext";
import { AutoManagePoller } from "@/components/AutoManagePoller";

export const metadata: Metadata = {
  title: "Cecil Trading",
  description: "Cecil Investments – Day Trading Assistant",
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
          <div className="min-h-screen pb-16">
            {children}
          </div>
        </TradingProvider>
      </body>
    </html>
  );
}
