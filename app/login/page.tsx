"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function resolveLoginRedirect(searchParams: ReadonlyURLSearchParams | null) {
  const maybeFrom = searchParams?.get("from");
  if (!maybeFrom) return "/today";

  try {
    const url = new URL(maybeFrom, "http://example.com");
    return `${url.pathname}${url.search}`;
  } catch {
    return "/today";
  }
}

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTarget = useMemo(
    () => resolveLoginRedirect(searchParams),
    [searchParams]
  );
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });

      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "Login failed.");
      }

      // On success, go to Today page (or home if you prefer)
      router.replace(redirectTarget);
    } catch (err: any) {
      console.error("Login error:", err);
      setError(err?.message || "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-screen login-screen">
      <div className="card login-card">
        <h1 className="login-title">Cecil Trading</h1>
        <p className="login-subtitle">Enter PIN to continue</p>

        <form onSubmit={handleSubmit} className="login-form">
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={12}
            className="login-input"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
          />

          {error && <p className="login-error">{error}</p>}

          <button
            type="submit"
            className="btn btn-primary login-button"
            disabled={loading || !pin}
          >
            {loading ? "Checking..." : "Unlock"}
          </button>
        </form>

        <p className="login-footer">Personal paper-trading assistant</p>
      </div>
    </div>
  );
}
