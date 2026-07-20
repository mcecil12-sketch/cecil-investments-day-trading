"use client";

import { useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency, formatPercent } from "@/lib/format";
import type { ExtractedPdfPosition, PdfExtractionResult } from "@/lib/portfolio/pdfImport";
import { findMatchingAccountId, type AccountOption } from "@/lib/portfolio/accountMatch";

interface AccountSelection {
  accountName: string;
  accountNumber: string;
  positions: ExtractedPdfPosition[];
  selectedAccountId: string;
}

interface ConfirmBatchResult {
  accountId: string;
  accountName: string | null;
  status: string;
  rowCount: number;
  errorMessage: string | null;
}

interface ConfirmResult {
  accountsImported: number;
  positionsImported: number;
  batches: ConfirmBatchResult[];
}

type Stage = "idle" | "extracting" | "preview" | "importing" | "done" | "error";

export function PdfImportForm({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [asOfDate, setAsOfDate] = useState<string | null>(null);
  const [selections, setSelections] = useState<AccountSelection[]>([]);
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStage("idle");
    setFileName(null);
    setAsOfDate(null);
    setSelections([]);
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
      const response = await fetch("/api/import/pdf", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Extraction failed");
      const result = body as PdfExtractionResult;
      setAsOfDate(result.asOfDate);
      setSelections(
        result.accounts.map((account) => ({
          accountName: account.accountName,
          accountNumber: account.accountNumber,
          positions: account.positions,
          selectedAccountId:
            findMatchingAccountId(accounts, account.accountName, account.accountNumber) ?? accounts[0]?.id ?? "",
        })),
      );
      setStage("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  function updateSelectedAccount(index: number, accountId: string) {
    setSelections((prev) => prev.map((s, i) => (i === index ? { ...s, selectedAccountId: accountId } : s)));
  }

  async function handleConfirm() {
    if (selections.length === 0 || selections.some((s) => !s.selectedAccountId)) return;
    setStage("importing");
    setError(null);
    try {
      const response = await fetch("/api/import/pdf/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asOfDate,
          fileName,
          accounts: selections.map((s) => ({ accountId: s.selectedAccountId, positions: s.positions })),
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
  const totalPositions = selections.reduce((sum, s) => sum + s.positions.length, 0);

  return (
    <div>
      <div
        className={`dropzone dropzone-recommended${dragging ? " dragging" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <div className="dropzone-title">
          {fileName ?? "Upload Fidelity PDF (All Accounts)"}
        </div>
        <div className="dropzone-hint">
          <span className="badge dropzone-badge">Recommended</span> Fastest — all accounts in one upload
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) handleFile(selected);
          }}
        />
      </div>

      {stage === "extracting" && (
        <div className="card">
          <p style={{ color: "var(--text-muted)" }}>Reading PDF with Claude…</p>
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

      {selections.length > 0 && (stage === "preview" || stage === "importing") && (
        <div className="card">
          <h2>Extracted Accounts</h2>
          <p style={{ color: "var(--text-muted)" }}>
            As of {asOfDate} — {selections.length} account{selections.length === 1 ? "" : "s"} —{" "}
            {totalPositions} position{totalPositions === 1 ? "" : "s"}
          </p>

          {selections.map((selection, index) => (
            <div key={`${selection.accountNumber}-${index}`} className="pdf-account-block">
              <div className="pdf-account-header">
                <div>
                  <div style={{ fontWeight: 600 }}>{selection.accountName}</div>
                  <div className="account-meta">Account #{selection.accountNumber}</div>
                </div>
                <div>
                  <label style={{ display: "block", color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.3rem" }}>
                    Import into account
                  </label>
                  <select
                    value={selection.selectedAccountId}
                    onChange={(e) => updateSelectedAccount(index, e.target.value)}
                  >
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Quantity</th>
                      <th>Value</th>
                      <th>Cost Basis</th>
                      <th>Gain/Loss</th>
                      <th>% of Account</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selection.positions.map((position, i) => (
                      <tr key={`${position.symbol}-${i}`}>
                        <td>
                          <span className="mono">{position.symbol}</span>
                          <div className="account-meta">{position.name}</div>
                        </td>
                        <td className="mono">{position.quantity?.toLocaleString() ?? "—"}</td>
                        <td className="mono">{formatCurrency(position.currentValue)}</td>
                        <td className="mono">{formatCurrency(position.costBasis)}</td>
                        <td
                          className="mono"
                          style={{
                            color:
                              position.gainLoss == null
                                ? undefined
                                : position.gainLoss >= 0
                                  ? "var(--positive)"
                                  : "var(--negative)",
                          }}
                        >
                          {formatCurrency(position.gainLoss)}
                          {position.gainLossPercent != null
                            ? ` (${formatPercent(position.gainLossPercent / 100)})`
                            : ""}
                        </td>
                        <td className="mono">
                          {position.percentOfAccount != null ? `${position.percentOfAccount.toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
            <button
              className="btn"
              type="button"
              disabled={busy || selections.some((s) => !s.selectedAccountId)}
              onClick={handleConfirm}
            >
              {stage === "importing" ? "Importing…" : "Import All Accounts"}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              style={{
                background: "transparent",
                color: "var(--text-muted)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "0.5rem 1rem",
                cursor: "pointer",
              }}
            >
              Choose a different PDF
            </button>
          </div>
        </div>
      )}

      {confirmResult && stage === "done" && (
        <div className="card">
          <h2>Import complete</h2>
          <p>
            {confirmResult.accountsImported} account{confirmResult.accountsImported === 1 ? "" : "s"} imported,{" "}
            {confirmResult.positionsImported} position{confirmResult.positionsImported === 1 ? "" : "s"} updated
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Rows</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {confirmResult.batches.map((batch, i) => (
                  <tr key={i}>
                    <td>{batch.accountName ?? "—"}</td>
                    <td>{batch.status}</td>
                    <td className="mono">{batch.rowCount}</td>
                    <td style={{ color: batch.errorMessage ? "var(--negative)" : undefined }}>
                      {batch.errorMessage ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn" type="button" onClick={reset} style={{ marginTop: "1rem" }}>
            Import another PDF
          </button>
        </div>
      )}
    </div>
  );
}
