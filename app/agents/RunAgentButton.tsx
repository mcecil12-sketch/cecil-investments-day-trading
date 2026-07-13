"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RunAgentButton({ endpoint }: { endpoint: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || `Request failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: "0.75rem" }}>
      <button className="btn" onClick={handleClick} disabled={loading}>
        {loading ? "Running…" : "Run Now"}
      </button>
      {error && <p style={{ color: "var(--negative)", fontSize: "0.8rem", marginTop: "0.4rem" }}>{error}</p>}
    </div>
  );
}
