"use client";

import { useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency } from "@/lib/format";
import type { VzLtiExtractionResult } from "@/lib/portfolio/vzLtiImport";
import type { AccountOption } from "@/lib/portfolio/accountMatch";

interface ConfirmResult {
  status: string;
  trancheCount: number;
  totalShares: number;
  vzPrice: number;
  totalValue: number;
}

type Stage = "idle" | "extracting" | "preview" | "importing" | "done" | "error";

export function VzLtiImportForm({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<VzLtiExtractionResult | null>(null);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStage("idle");
    setFileName(null);
    setExtraction(null);
    setConfirmResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleFile(selected: File) {
    setFileName(selected.name);
    setError(null);
    setConfirmResult(null);
    setStage("extracting");
    try {
      const formData = new FormData();
      formData.set("file", selected);
      const response = await fetch("/api/import/vz-lti", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Extraction failed");
      setExtraction(body as VzLtiExtractionResult);
      setStage("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  async function handleConfirm() {
    if (!extraction || !accountId) return;
    setStage("importing");
    setError(null);
    try {
      const response = await fetch("/api/import/vz-lti/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          asOfDate: extraction.asOfDate,
          tranches: extraction.tranches,
          fileName,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Import failed");
      setConfirmResult(body as ConfirmResult);
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

  const busy = stage === "extracting" || stage === "importing";
  const totalShares = extraction?.tranches.reduce((sum, t) => sum + t.shares, 0) ?? 0;

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
        <div className="dropzone-title">{fileName ?? "Upload Fidelity Stock Plans Screenshot"}</div>
        <div className="dropzone-hint">
          The LTI grant/vesting schedule from Fidelity&apos;s Stock Plans tab — shares per grant cohort and vest
          year, not a flat balance. Balance is computed from shares × VZ&apos;s current price, not typed in.
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) handleFile(selected);
          }}
        />
      </div>

      {stage === "extracting" && (
        <div className="card">
          <p style={{ color: "var(--text-muted)" }}>Reading screenshot with Claude…</p>
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

      {extraction && (stage === "preview" || stage === "importing") && (
        <div className="card">
          <h2>Extracted Grant Schedule</h2>
          <p style={{ color: "var(--text-muted)" }}>
            As of {extraction.asOfDate} — {extraction.tranches.length} unvested third
            {extraction.tranches.length === 1 ? "" : "s"}, {totalShares.toFixed(2)} total shares
          </p>

          <div style={{ marginBottom: "0.75rem" }}>
            <label style={{ marginRight: "0.5rem" }}>Account:</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cohort</th>
                  <th>Vest Date</th>
                  <th>Shares</th>
                </tr>
              </thead>
              <tbody>
                {extraction.tranches.map((t, i) => (
                  <tr key={`${t.cohortLabel}-${t.vestDate}-${i}`}>
                    <td>{t.cohortLabel}</td>
                    <td className="mono">{t.vestDate}</td>
                    <td className="mono">{t.shares.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
            <button className="btn" type="button" disabled={busy || !accountId} onClick={handleConfirm}>
              {stage === "importing" ? "Importing…" : "Import Grant Schedule"}
            </button>
            <button className="btn-secondary" type="button" onClick={reset} disabled={busy}>
              Choose a different screenshot
            </button>
          </div>
        </div>
      )}

      {confirmResult && stage === "done" && (
        <div className="card">
          <h2>Import complete</h2>
          <p>
            {confirmResult.trancheCount} tranche{confirmResult.trancheCount === 1 ? "" : "s"},{" "}
            {confirmResult.totalShares.toFixed(2)} total shares at {formatCurrency(confirmResult.vzPrice)}/share ={" "}
            {formatCurrency(confirmResult.totalValue)}
          </p>
          <button className="btn" type="button" onClick={reset} style={{ marginTop: "1rem" }}>
            Import another screenshot
          </button>
        </div>
      )}
    </div>
  );
}
