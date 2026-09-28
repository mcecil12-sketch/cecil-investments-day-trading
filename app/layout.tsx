import type { Metadata } from "next";
import "./globals.css";
import { BottomNav } from "@/components/BottomNav";
import { LockButton } from "@/components/LockButton";

export const metadata: Metadata = {
  title: "Cecil Investments — Portfolio Benchmark",
  description: "Portfolio performance vs. S&P 500 across all accounts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LockButton />
        <main>{children}</main>
        <BottomNav />
      </body>
    </html>
  );
}
