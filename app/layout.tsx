import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cecil Investments — Portfolio Benchmark",
  description: "Portfolio performance vs. S&P 500 across all accounts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="app-nav">
          <a href="/">Home</a>
          <a href="/accounts">Accounts</a>
          <a href="/import">Import</a>
          <a href="/benchmark">Benchmark</a>
          <a href="/dashboard">Dashboard</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
