"use client";

import { useState, type FormEvent } from "react";

interface ImportBatchResult {
  accountId: string;
  accountExternalId: string;
  accountName: string;
  accountCreated: boolean;
  status: string;
  rowCount: number;
  errorMessage: string | null;
}

interface ImportResult {
  asOfDate: string;
  parserWarnings: string[];
  batches: ImportBatchResult[];
}

export function ImportForm() {
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;

    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/import/fidelity", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Import failed");
      setResult(body as ImportResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <form className="card" onSubmit={handleSubmit}>
        <h2>Upload Fidelity export</h2>
        <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
          Export "Portfolio Positions" as CSV from Fidelity — one file can cover multiple
          accounts and each gets its own import result below.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
        {error && <p style={{ color: "#ff4e4e" }}>{error}</p>}
        <div style={{ marginTop: "0.75rem" }}>
          <button className="btn" type="submit" disabled={!file || submitting}>
            {submitting ? "Importing…" : "Import"}
          </button>
        </div>
      </form>

      {result && (
        <div className="card">
          <h2>Import results</h2>
          <p style={{ color: "var(--text-muted)" }}>
            As-of {new Date(result.asOfDate).toLocaleDateString()}
          </p>
          {result.parserWarnings.length > 0 && (
            <ul style={{ color: "#ffb347" }}>
              {result.parserWarnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          )}
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>External ID</th>
                <th>Status</th>
                <th>Rows</th>
                <th>New account?</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {result.batches.map((batch, i) => (
                <tr key={i}>
                  <td>{batch.accountName}</td>
                  <td>{batch.accountExternalId}</td>
                  <td>{batch.status}</td>
                  <td>{batch.rowCount}</td>
                  <td>{batch.accountCreated ? "Yes" : "No"}</td>
                  <td style={{ color: batch.errorMessage ? "#ff4e4e" : undefined }}>
                    {batch.errorMessage ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
