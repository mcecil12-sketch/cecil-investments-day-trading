"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    try {
      fetch("/api/client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: error?.message,
          stack: error?.stack,
          digest: (error as any)?.digest,
          href: typeof window !== "undefined" ? window.location.href : null,
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
          ts: new Date().toISOString(),
        }),
      }).catch(() => {});
    } catch {}
  }, [error]);

  return (
    <html>
      <body style={{ fontFamily: "system-ui", padding: 24 }}>
        <h2>App error</h2>
        <p>The app hit a client-side exception. Please refresh.</p>
        <button onClick={() => reset()}>Try again</button>
      </body>
    </html>
  );
}
