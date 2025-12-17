import type { Metadata } from "next";

import "./globals.css";
import { TradingProvider } from "./tradingContext";
import { AutoManagePoller } from "@/components/AutoManagePoller";
import { AppShell } from "@/components/AppShell";
import { HeartbeatPoller } from "@/components/HeartbeatPoller";
import { AiHeartbeatPing } from "@/components/AiHeartbeatPing";

export const metadata: Metadata = {
  applicationName: "Cecil Trading",
  title: "Cecil Trading",
  description: "AI-powered day trading assistant",
  manifest: "/manifest.json",
  themeColor: "#000000",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Cecil Trading",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      </head>
      <body>
        <TradingProvider>
          <HeartbeatPoller />
          <AiHeartbeatPing />
          <AutoManagePoller />
          <AppShell>{children}</AppShell>
        </TradingProvider>
      </body>
    </html>
  );
}

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};
