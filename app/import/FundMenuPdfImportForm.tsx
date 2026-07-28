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

type GroupStage = "extracting" | "preview" | "error" | "done";

interface FileGroup {
  id: string;
  fileLabel: string;
  stage: GroupStage;
  asOfDate: string | null;
  selections: AccountSelection[];
  error: string | null;
  confirmResult: ConfirmResult | null;
}

let fileGroupCounter = 0;

export function FundMenuPdfImportForm({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [importing, setImporting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function updateGroup(id: string, patch: Partial<FileGroup>) {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }

  function reset() {
    setGroups([]);
    setImporting(false);
    setFormError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  /**
   * All files chosen in a single picker/drop action are treated as one
   * document — e.g. several successive scroll screenshots of the same
   * continuous fund menu table — and sent to the extraction endpoint
   * together so Claude can combine them into one result instead of
   * re-detecting headers (which won't be present past the first image) in
   * each one independently. To upload a second plan's menu, do a separate
   * picker/drop action, which creates its own group.
   */
  async function extractGroup(files: File[]) {
    const id = `fund-menu-${++fileGroupCounter}`;
    const fileLabel = files.length === 1 ? files[0].name : `${files.length} files (${files.map((f) => f.name).join(", ")})`;
    setGroups((prev) => [
      ...prev,
      { id, fileLabel, stage: "extracting", asOfDate: null, selections: [], error: null, confirmResult: null },
    ]);
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append("file", file));
      const response = await fetch("/api/import/fund-menu-pdf", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Extraction failed");
      const result = body as FundMenuPdfExtractionResult;
      updateGroup(id, {
        stage: "preview",
        asOfDate: result.asOfDate,
        selections: result.accounts.map((account) => ({
          accountName: account.accountName,
          accountNumber: account.accountNumber,
          funds: account.funds,
          selectedAccountId:
            findMatchingAccountId(accounts, account.accountName, account.accountNumber) ?? accounts[0]?.id ?? "",
        })),
      });
    } catch (err) {
      updateGroup(id, { stage: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleFiles(files: FileList | File[]) {
    setFormError(null);
    const list = Array.from(files);
    if (list.length > 0) extractGroup(list);
  }

  function updateSelectedAccount(groupId: string, selectionIndex: number, accountId: string) {
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId
          ? { ...g, selections: g.selections.map((s, i) => (i === selectionIndex ? { ...s, selectedAccountId: accountId } : s)) }
          : g,
      ),
    );
  }

  async function handleConfirmAll() {
    const ready = groups.filter((g) => g.stage === "preview" && g.selections.every((s) => s.selectedAccountId));
    if (ready.length === 0) return;
    setImporting(true);
    setFormError(null);
    try {
      await Promise.all(
        ready.map(async (group) => {
          try {
            const response = await fetch("/api/import/fund-menu-pdf/confirm", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                asOfDate: group.asOfDate,
                fileName: group.fileLabel,
                accounts: group.selections.map((s) => ({ accountId: s.selectedAccountId, funds: s.funds })),
              }),
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error ?? "Import failed");
            updateGroup(group.id, { stage: "done", confirmResult: body as ConfirmResult });
          } catch (err) {
            updateGroup(group.id, { stage: "error", error: err instanceof Error ? err.message : String(err) });
          }
        }),
      );
      router.refresh();
    } finally {
      setImporting(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files?.length) handleFiles(event.dataTransfer.files);
  }

  const readyGroups = groups.filter((g) => g.stage === "preview");
  const canImportAll = readyGroups.length > 0 && readyGroups.every((g) => g.selections.every((s) => s.selectedAccountId));

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
          {groups.length > 0 ? `${groups.length} file${groups.length === 1 ? "" : "s"} selected` : "Upload plan fund menu (PDF or screenshot)"}
        </div>
        <div className="dropzone-hint">
          The complete "Investment Choices" list from Fidelity's plan performance page — all funds, held or not. PDF
          export or PNG/JPG screenshots both work. If one plan's menu spans several screenshots (e.g. scrolling
          down a long table), select or drop all of that plan's images together in one action — they're combined
          into one continuous table. Do a separate upload action for the other plan. Check the extracted fund count
          against the plan's actual menu size before importing.
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,application/pdf,.png,.jpg,.jpeg,image/png,image/jpeg"
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files);
          }}
        />
      </div>

      {formError && (
        <div className="card">
          <p style={{ color: "var(--negative)" }}>{formError}</p>
        </div>
      )}

      {groups.map((group) => (
        <div key={group.id} className="card">
          <h2>{group.fileLabel}</h2>

          {group.stage === "extracting" && <p style={{ color: "var(--text-muted)" }}>Reading fund menu with Claude…</p>}

          {group.stage === "error" && (
            <p style={{ color: "var(--negative)" }}>{group.error}</p>
          )}

          {(group.stage === "preview" || group.stage === "done") && (
            <>
              <p style={{ color: "var(--text-muted)" }}>
                As of {group.asOfDate} —{" "}
                {group.selections.reduce((sum, s) => sum + s.funds.length, 0)} fund
                {group.selections.reduce((sum, s) => sum + s.funds.length, 0) === 1 ? "" : "s"}
              </p>

              {group.selections.map((selection, index) => (
                <div key={`${selection.accountNumber}-${index}`} className="pdf-account-block">
                  <div className="pdf-account-header">
                    <div>
                      <div style={{ fontWeight: 600 }}>{selection.accountName}</div>
                      <div className="account-meta">
                        Account #{selection.accountNumber} — {selection.funds.length} funds (
                        {selection.funds.filter((f) => f.isHeld).length} currently held)
                      </div>
                    </div>
                    {group.stage === "preview" && (
                      <div>
                        <label style={{ display: "block", color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.3rem" }}>
                          Import into plan
                        </label>
                        <select
                          value={selection.selectedAccountId}
                          onChange={(e) => updateSelectedAccount(group.id, index, e.target.value)}
                        >
                          {accounts.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
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

              {group.stage === "done" && group.confirmResult && (
                <p style={{ color: "var(--positive)" }}>
                  Imported — {group.confirmResult.fundsImported} fund{group.confirmResult.fundsImported === 1 ? "" : "s"}{" "}
                  across {group.confirmResult.accountsImported} plan{group.confirmResult.accountsImported === 1 ? "" : "s"}.
                </p>
              )}
            </>
          )}
        </div>
      ))}

      {groups.length > 0 && (
        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem" }}>
          <button className="btn" type="button" disabled={importing || !canImportAll} onClick={handleConfirmAll}>
            {importing ? "Importing…" : `Import ${readyGroups.length > 1 ? "All Fund Menus" : "Fund Menu"}`}
          </button>
          <button className="btn-secondary" type="button" onClick={reset} disabled={importing}>
            Choose different files
          </button>
        </div>
      )}
    </div>
  );
}
