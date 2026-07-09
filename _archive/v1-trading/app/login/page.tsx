"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redirectTarget, setRedirectTarget] = useState("/today");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const maybeFrom = params.get("from");
    if (!maybeFrom) {
      setRedirectTarget("/today");
      return;
    }

    try {
      const url = new URL(maybeFrom, window.location.origin);
      setRedirectTarget(`${url.pathname}${url.search}`);
    } catch {
      setRedirectTarget("/today");
    }
  }, []);
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

      // On success, go to resolved target
      router.refresh();
      router.replace(redirectTarget);

      if (typeof window !== "undefined") {
        window.location.assign(redirectTarget);
      }
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
