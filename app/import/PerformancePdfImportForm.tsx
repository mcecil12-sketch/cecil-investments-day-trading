"use client";

import { useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { formatPercent } from "@/lib/format";
import type {
  ExtractedAccountReturns,
  ExtractedSp500Returns,
  PerformancePdfExtractionResult,
} from "@/lib/portfolio/performancePdfImport";
import { findMatchingAccountId, type AccountOption } from "@/lib/portfolio/accountMatch";

interface AccountSelection {
  accountName: string;
  accountNumber: string;
  returns: ExtractedAccountReturns;
  selectedAccountId: string;
}

interface ConfirmBatchResult {
  accountId: string;
  accountName: string | null;
  status: string;
  periodCount: number;
  errorMessage: string | null;
}

interface ConfirmResult {
  accountsImported: number;
  batches: ConfirmBatchResult[];
  totalPortfolioPeriodCount: number;
}

type Stage = "idle" | "extracting" | "preview" | "importing" | "done" | "error";

const RETURN_COLUMNS: { key: keyof ExtractedAccountReturns & keyof ExtractedSp500Returns; label: string }[] = [
  { key: "oneMonth", label: "1M" },
  { key: "threeMonth", label: "3M" },
  { key: "ytd", label: "YTD" },
  { key: "oneYear", label: "1Y" },
  { key: "threeYear", label: "3Y" },
  { key: "fiveYear", label: "5Y" },
];

export function PerformancePdfImportForm({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [asOfDate, setAsOfDate] = useState<string | null>(null);
  const [selections, setSelections] = useState<AccountSelection[]>([]);
  const [totalPortfolio, setTotalPortfolio] = useState<ExtractedAccountReturns | null>(null);
  const [sp500, setSp500] = useState<ExtractedSp500Returns | null>(null);
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStage("idle");
    setFileName(null);
    setAsOfDate(null);
    setSelections([]);
    setTotalPortfolio(null);
    setSp500(null);
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
      const response = await fetch("/api/import/performance-pdf", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Extraction failed");
      const result = body as PerformancePdfExtractionResult;
      setAsOfDate(result.asOfDate);
      setSp500(result.benchmarks.sp500);
      setTotalPortfolio(result.totalPortfolio);
      setSelections(
        result.accounts.map((account) => ({
          accountName: account.accountName,
          accountNumber: account.accountNumber,
          returns: account.returns,
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
    if (selections.length === 0 || selections.some((s) => !s.selectedAccountId) || !sp500) return;
    setStage("importing");
    setError(null);
    try {
      const response = await fetch("/api/import/performance-pdf/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asOfDate,
          fileName,
          benchmarks: { sp500 },
          totalPortfolio,
          accounts: selections.map((s) => ({ accountId: s.selectedAccountId, returns: s.returns })),
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
        <div className="dropzone-title">{fileName ?? "Upload Fidelity Performance PDF"}</div>
        <div className="dropzone-hint">
          Imports actual account returns — upload weekly alongside positions PDF
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

      {selections.length > 0 && sp500 && (stage === "preview" || stage === "importing") && (
        <div className="card">
          <h2>Extracted Returns</h2>
          <p style={{ color: "var(--text-muted)" }}>
            As of {asOfDate} — {selections.length} account{selections.length === 1 ? "" : "s"}
          </p>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  {RETURN_COLUMNS.map((col) => (
                    <th key={col.key}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ fontWeight: 600 }}>S&amp;P 500</td>
                  {RETURN_COLUMNS.map((col) => (
                    <td key={col.key} className="mono">
                      {formatPercent(sp500[col.key])}
                    </td>
                  ))}
                </tr>
                {totalPortfolio && (
                  <tr>
                    <td style={{ fontWeight: 600 }}>
                      Total Portfolio <span className="badge">from PDF</span>
                    </td>
                    {RETURN_COLUMNS.map((col) => (
                      <td key={col.key} className="mono">
                        {formatPercent(totalPortfolio[col.key])}
                      </td>
                    ))}
                  </tr>
                )}
                {selections.map((selection, index) => (
                  <tr key={`${selection.accountNumber}-${index}`}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{selection.accountName}</div>
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
                    </td>
                    {RETURN_COLUMNS.map((col) => (
                      <td key={col.key} className="mono">
                        {formatPercent(selection.returns[col.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
            <button
              className="btn"
              type="button"
              disabled={busy || selections.some((s) => !s.selectedAccountId)}
              onClick={handleConfirm}
            >
              {stage === "importing" ? "Importing…" : "Import All Accounts"}
            </button>
            <button className="btn-secondary" type="button" onClick={reset} disabled={busy}>
              Choose a different PDF
            </button>
          </div>
        </div>
      )}

      {confirmResult && stage === "done" && (
        <div className="card">
          <h2>Import complete</h2>
          <p>
            Returns updated for {confirmResult.accountsImported} account{confirmResult.accountsImported === 1 ? "" : "s"}
            {confirmResult.totalPortfolioPeriodCount > 0 && " — Total Portfolio row also updated"}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Periods</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {confirmResult.batches.map((batch, i) => (
                  <tr key={i}>
                    <td>{batch.accountName ?? "—"}</td>
                    <td>{batch.status}</td>
                    <td className="mono">{batch.periodCount}</td>
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
