"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const ACCOUNT_TYPES = [
  { value: "FIDELITY_TAXABLE", label: "Fidelity Taxable" },
  { value: "VZ_SAVINGS_401K", label: "Verizon Savings Plan 401k" },
  { value: "VZ_LEGACY_401K", label: "Verizon Mid-Atlantic Legacy 401k" },
  { value: "VZ_EDP", label: "Verizon EDP (locked)" },
];

export function NewAccountForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [type, setType] = useState(ACCOUNT_TYPES[0].value);
  const [institution, setInstitution] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type, institution, isLocked: type === "VZ_EDP" }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to create account");
      }
      setName("");
      setInstitution("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h2>Add account</h2>
      <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
        Fidelity taxable accounts are usually created automatically on first CSV import — use
        this form for the Verizon 401k/EDP accounts, which have no CSV import path yet.
      </p>
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        <input
          placeholder="Account name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {ACCOUNT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          placeholder="Institution"
          value={institution}
          onChange={(e) => setInstitution(e.target.value)}
          required
        />
      </div>
      {error && <p style={{ color: "#ff4e4e" }}>{error}</p>}
      <button className="btn" type="submit" disabled={submitting}>
        {submitting ? "Adding…" : "Add account"}
      </button>
    </form>
  );
}
