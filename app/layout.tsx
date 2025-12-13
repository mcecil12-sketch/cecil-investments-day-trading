import "./globals.css";
import { TradingProvider } from "./tradingContext";
import { AutoManagePoller } from "@/components/AutoManagePoller";
import { AppShell } from "@/components/AppShell";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <TradingProvider>
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
