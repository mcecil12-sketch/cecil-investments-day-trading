"use client";

import { useEffect } from "react";

export function ClientErrorReporter() {
  useEffect(() => {
    const post = (payload: any) => {
      try {
        fetch("/api/client-error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            href: window.location.href,
            userAgent: navigator.userAgent,
            ts: new Date().toISOString(),
          }),
        }).catch(() => {});
      } catch {}
    };

    const onError = (event: ErrorEvent) => {
      post({
        type: "window.error",
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: (event.error && event.error.stack) || null,
      });
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason: any = event.reason;
      post({
        type: "window.unhandledrejection",
        message: reason?.message || String(reason),
        stack: reason?.stack || null,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
