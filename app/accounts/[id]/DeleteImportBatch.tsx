"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteImportBatch({ importBatchId, fileName }: { importBatchId: string; fileName: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/import-batches/${importBatchId}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to delete import");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <button
        className="btn-secondary"
        type="button"
        style={{ fontSize: "0.75rem", padding: "0.1rem 0.5rem" }}
        onClick={() => setConfirming(true)}
      >
        Delete this import
      </button>
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
      <span style={{ color: "var(--negative)", fontSize: "0.8rem" }}>
        Permanently delete all positions from &quot;{fileName}&quot;?
      </span>
      <button className="btn" type="button" onClick={handleDelete} disabled={deleting}>
        {deleting ? "Deleting…" : "Yes, delete"}
      </button>
      <button className="btn-secondary" type="button" onClick={() => setConfirming(false)} disabled={deleting}>
        Cancel
      </button>
      {error && <span style={{ color: "var(--negative)", fontSize: "0.75rem" }}>{error}</span>}
    </span>
  );
}
