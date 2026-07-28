"use client";

import { useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { formatPercent } from "@/lib/format";
import type { ExtractedFundMenuEntry, FundMenuPdfExtractionResult } from "@/lib/portfolio/fundMenuPdfImport";
import { findMatchingAccountId, type AccountOption } from "@/lib/portfolio/accountMatch";

interface AccountSelection {
  accountName: string;
  accountNumber: string;
  funds: ExtractedFundMenuEntry[];
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
  fundsImported: number;
  batches: ConfirmBatchResult[];
}

type Stage = "idle" | "extracting" | "preview" | "importing" | "done" | "error";

export function FundMenuPdfImportForm({ accounts }: { accounts: AccountOption[] }) {
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
      const response = await fetch("/api/import/fund-menu-pdf", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Extraction failed");
      const result = body as FundMenuPdfExtractionResult;
      setAsOfDate(result.asOfDate);
      setSelections(
        result.accounts.map((account) => ({
          accountName: account.accountName,
          accountNumber: account.accountNumber,
          funds: account.funds,
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
      const response = await fetch("/api/import/fund-menu-pdf/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asOfDate,
          fileName,
          accounts: selections.map((s) => ({ accountId: s.selectedAccountId, funds: s.funds })),
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
  const totalFunds = selections.reduce((sum, s) => sum + s.funds.length, 0);

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
        <div className="dropzone-title">{fileName ?? "Upload plan fund menu PDF"}</div>
        <div className="dropzone-hint">The complete "Investment Choices" list from Fidelity's plan performance page — all funds, held or not</div>
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
          <p style={{ color: "var(--text-muted)" }}>Reading fund menu with Claude…</p>
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
          <h2>Extracted Fund Menu</h2>
          <p style={{ color: "var(--text-muted)" }}>
            As of {asOfDate} — {selections.length} plan{selections.length === 1 ? "" : "s"} — {totalFunds} fund
            {totalFunds === 1 ? "" : "s"}
          </p>

          {selections.map((selection, index) => (
            <div key={`${selection.accountNumber}-${index}`} className="pdf-account-block">
              <div className="pdf-account-header">
                <div>
                  <div style={{ fontWeight: 600 }}>{selection.accountName}</div>
                  <div className="account-meta">
                    Account #{selection.accountNumber} — {selection.funds.length} funds (
                    {selection.funds.filter((f) => f.isHeld).length} currently held)
                  </div>
                </div>
                <div>
                  <label style={{ display: "block", color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.3rem" }}>
                    Import into plan
                  </label>
                  <select value={selection.selectedAccountId} onChange={(e) => updateSelectedAccount(index, e.target.value)}>
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
                      <th>Fund</th>
                      <th>Asset Class</th>
                      <th>Held</th>
                      <th>1Y</th>
                      <th>3Y</th>
                      <th>5Y</th>
                      <th>10Y</th>
                      <th>Inception</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selection.funds.map((fund, i) => (
                      <tr key={`${fund.fundName}-${i}`}>
                        <td>
                          {fund.fundName}
                          {fund.ticker && <span className="account-meta"> ({fund.ticker})</span>}
                        </td>
                        <td>{fund.assetClass ?? "—"}</td>
                        <td>{fund.isHeld ? "✓" : "—"}</td>
                        <td className="mono">{fund.oneYear != null ? formatPercent(fund.oneYear) : "—"}</td>
                        <td className="mono">{fund.threeYear != null ? formatPercent(fund.threeYear) : "—"}</td>
                        <td className="mono">{fund.fiveYear != null ? formatPercent(fund.fiveYear) : "—"}</td>
                        <td className="mono">{fund.tenYear != null ? formatPercent(fund.tenYear) : "—"}</td>
                        <td className="mono">{fund.inceptionDate ?? "—"}</td>
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
              {stage === "importing" ? "Importing…" : "Import Fund Menu"}
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
            {confirmResult.accountsImported} plan{confirmResult.accountsImported === 1 ? "" : "s"} imported,{" "}
            {confirmResult.fundsImported} fund{confirmResult.fundsImported === 1 ? "" : "s"} updated
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Funds</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {confirmResult.batches.map((batch, i) => (
                  <tr key={i}>
                    <td>{batch.accountName ?? "—"}</td>
                    <td>{batch.status}</td>
                    <td className="mono">{batch.rowCount}</td>
                    <td style={{ color: batch.errorMessage ? "var(--negative)" : undefined }}>{batch.errorMessage ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn" type="button" onClick={reset} style={{ marginTop: "1rem" }}>
            Import another fund menu
          </button>
        </div>
      )}
    </div>
  );
}
