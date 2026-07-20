"use client";

import { useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import type { FidelityPreviewResult } from "@/app/api/import/fidelity/preview/route";

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

type Stage = "idle" | "previewing" | "preview-ready" | "importing" | "done" | "error";

export function ImportForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<FidelityPreviewResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStage("idle");
    setFile(null);
    setPreview(null);
    setImportResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleFile(selected: File) {
    setFile(selected);
    setError(null);
    setImportResult(null);
    setStage("previewing");
    try {
      const formData = new FormData();
      formData.set("file", selected);
      const response = await fetch("/api/import/fidelity/preview", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not read that file");
      setPreview(body as FidelityPreviewResult);
      setStage("preview-ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  async function handleConfirm() {
    if (!file) return;
    setStage("importing");
    setError(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/import/fidelity", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Import failed");
      setImportResult(body as ImportResult);
      setStage("done");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) handleFile(dropped);
  }

  const busy = stage === "previewing" || stage === "importing";

  return (
    <div>
      <div
        className={`dropzone${dragging ? " dragging" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <div className="dropzone-title">
          {file ? file.name : "Drop a Fidelity Portfolio Positions CSV here"}
        </div>
        <div className="dropzone-hint">or click to browse — one file can cover multiple accounts</div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) handleFile(selected);
          }}
        />
      </div>

      {stage === "previewing" && (
        <div className="card">
          <p style={{ color: "var(--text-muted)" }}>Reading file…</p>
        </div>
      )}

      {error && (
        <div className="card">
          <p style={{ color: "var(--negative)" }}>{error}</p>
          <button className="btn" type="button" onClick={reset}>
            Try again
          </button>
        </div>
      )}

      {preview && (stage === "preview-ready" || stage === "importing") && (
        <div className="card">
          <h2>Preview</h2>
          <p style={{ color: "var(--text-muted)" }}>
            As-of{" "}
            {preview.asOfDate ? new Date(preview.asOfDate).toLocaleDateString() : "unknown date"} —{" "}
            {preview.accounts.length} account{preview.accounts.length === 1 ? "" : "s"} detected
          </p>
          {preview.warnings.length > 0 && (
            <ul style={{ color: "var(--accent)" }}>
              {preview.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>External ID</th>
                  <th>Rows</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.accounts.map((account) => (
                  <tr key={account.externalId}>
                    <td>{account.accountExists ? account.existingAccountName : account.accountName}</td>
                    <td className="mono">{account.externalId}</td>
                    <td className="mono">{account.rowCount}</td>
                    <td>
                      <span
                        className="badge"
                        style={{ color: account.accountExists ? "var(--text-muted)" : "var(--accent)" }}
                      >
                        {account.accountExists ? "Existing account" : "New account"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
            <button className="btn" type="button" disabled={busy} onClick={handleConfirm}>
              {stage === "importing" ? "Importing…" : "Confirm import"}
            </button>
            <button className="btn-secondary" type="button" onClick={reset} disabled={busy}>
              Choose a different file
            </button>
          </div>
        </div>
      )}

      {importResult && stage === "done" && (
        <div className="card">
          <h2>Import complete</h2>
          <div className="table-wrap">
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
                {importResult.batches.map((batch, i) => (
                  <tr key={i}>
                    <td>{batch.accountName}</td>
                    <td className="mono">{batch.accountExternalId}</td>
                    <td>{batch.status}</td>
                    <td className="mono">{batch.rowCount}</td>
                    <td>{batch.accountCreated ? "Yes" : "No"}</td>
                    <td style={{ color: batch.errorMessage ? "var(--negative)" : undefined }}>
                      {batch.errorMessage ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: "1rem" }}>
            <button className="btn" type="button" onClick={reset}>
              Import another file
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
