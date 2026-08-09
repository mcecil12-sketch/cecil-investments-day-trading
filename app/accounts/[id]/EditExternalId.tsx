"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function EditExternalId({ accountId, externalId }: { accountId: string; externalId: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(externalId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalId: value.trim() || null }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to save account number");
      }
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <span>
        {externalId ? `Account #${externalId}` : (
          <span style={{ color: "var(--negative)" }}>No account number set — imports fall back to name matching</span>
        )}{" "}
        <button
          className="btn-secondary"
          type="button"
          style={{ fontSize: "0.75rem", padding: "0.1rem 0.5rem" }}
          onClick={() => {
            setValue(externalId ?? "");
            setEditing(true);
          }}
        >
          {externalId ? "Edit" : "Set account number"}
        </button>
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Account number as shown on statements"
        style={{ fontSize: "0.85rem" }}
        autoFocus
      />
      <button className="btn-secondary" type="button" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button className="btn-secondary" type="button" onClick={() => setEditing(false)} disabled={saving}>
        Cancel
      </button>
      {error && <span style={{ color: "var(--negative)", fontSize: "0.75rem" }}>{error}</span>}
    </span>
  );
}
