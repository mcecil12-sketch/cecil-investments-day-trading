"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  weeklyBriefId: string;
  actionItemIndex: number;
  initialExecuted: boolean | null;
  initialNotes: string;
}

export function OutcomeControls({ weeklyBriefId, actionItemIndex, initialExecuted, initialNotes }: Props) {
  const router = useRouter();
  const [executed, setExecuted] = useState(initialExecuted);
  const [notes, setNotes] = useState(initialNotes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(nextExecuted: boolean, nextNotes: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/recommendations/outcome", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weeklyBriefId, actionItemIndex, executed: nextExecuted, notes: nextNotes }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setExecuted(nextExecuted);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: "0.4rem" }}>
        <button
          className={executed === true ? "btn" : "btn-secondary"}
          disabled={saving}
          onClick={() => save(true, notes)}
        >
          Executed
        </button>
        <button
          className={executed === false ? "btn" : "btn-secondary"}
          disabled={saving}
          onClick={() => save(false, notes)}
        >
          Skipped
        </button>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => {
          if (executed != null) save(executed, notes);
        }}
        placeholder="Notes…"
        rows={2}
        style={{
          width: "100%",
          marginTop: "0.4rem",
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "0.4rem",
          fontSize: "0.8rem",
          fontFamily: "inherit",
        }}
      />
      {error && <p style={{ color: "var(--negative)", fontSize: "0.75rem", marginTop: "0.2rem" }}>{error}</p>}
    </div>
  );
}
