"use client";

import { useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency, formatPercent } from "@/lib/format";
import type { ExtractedPosition, ScreenshotExtractionResult } from "@/lib/portfolio/screenshotImport";

interface AccountOption {
  id: string;
  name: string;
}

interface ConfirmResult {
  accountId: string;
  accountName: string;
  status: string;
  rowCount: number;
  errorMessage: string | null;
}

type Stage = "idle" | "extracting" | "preview" | "importing" | "done" | "error";

/** Matches Claude's extracted account name against the known accounts list so the picker can default to it instead of always falling back to the first account. */
function findMatchingAccountId(accounts: AccountOption[], extractedName: string): string | undefined {
  const normalize = (value: string) => value.trim().toLowerCase();
  const target = normalize(extractedName);
  const exact = accounts.find((account) => normalize(account.name) === target);
  if (exact) return exact.id;
  const partial = accounts.find(
    (account) => normalize(account.name).includes(target) || target.includes(normalize(account.name)),
  );
  return partial?.id;
}

export function ScreenshotImportForm({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<ScreenshotExtractionResult | null>(null);
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? "");
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
      const response = await fetch("/api/import/screenshot", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Extraction failed");
      const result = body as ScreenshotExtractionResult;
      setExtraction(result);
      setAccountId(findMatchingAccountId(accounts, result.accountName) ?? accounts[0]?.id ?? "");
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
      const response = await fetch("/api/import/screenshot/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          asOfDate: extraction.asOfDate,
          positions: extraction.positions,
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
        <div className="dropzone-title">{fileName ?? "Upload Screenshot"}</div>
        <div className="dropzone-hint">
          PNG or JPG of a brokerage account page — Claude reads the positions for you
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
          <h2>Extracted Positions</h2>
          <p style={{ color: "var(--text-muted)" }}>
            {extraction.accountName} — as of {extraction.asOfDate} —{" "}
            {extraction.positions.length} position{extraction.positions.length === 1 ? "" : "s"}
          </p>

          <div style={{ marginBottom: "0.75rem" }}>
            <label style={{ display: "block", color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.3rem" }}>
              Import into account
            </label>
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
                  <th>Symbol</th>
                  <th>Quantity</th>
                  <th>Value</th>
                  <th>Cost Basis</th>
                  <th>Gain/Loss</th>
                  <th>% of Account</th>
                  <th>YTD</th>
                </tr>
              </thead>
              <tbody>
                {extraction.positions.map((position: ExtractedPosition, i: number) => (
                  <tr key={`${position.symbol}-${i}`}>
                    <td>
                      <span className="mono">{position.symbol}</span>
                      <div className="account-meta">{position.name}</div>
                    </td>
                    <td className="mono">{position.quantity.toLocaleString()}</td>
                    <td className="mono">{formatCurrency(position.currentValue)}</td>
                    <td className="mono">{formatCurrency(position.costBasis)}</td>
                    <td
                      className="mono"
                      style={{ color: position.gainLoss >= 0 ? "var(--positive)" : "var(--negative)" }}
                    >
                      {formatCurrency(position.gainLoss)} ({formatPercent(position.gainLossPercent / 100)})
                    </td>
                    <td className="mono">{position.percentOfAccount.toFixed(1)}%</td>
                    <td className="mono">{formatPercent(position.ytdReturn ?? null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
            <button className="btn" type="button" disabled={busy || !accountId} onClick={handleConfirm}>
              {stage === "importing" ? "Importing…" : "Confirm import"}
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
              Choose a different screenshot
            </button>
          </div>
        </div>
      )}

      {confirmResult && stage === "done" && (
        <div className="card">
          <h2>Import complete</h2>
          <p>
            {confirmResult.accountName} —{" "}
            <span style={{ color: confirmResult.errorMessage ? "var(--negative)" : "var(--positive)" }}>
              {confirmResult.status}
            </span>{" "}
            — {confirmResult.rowCount} position{confirmResult.rowCount === 1 ? "" : "s"}
          </p>
          {confirmResult.errorMessage && (
            <p style={{ color: "var(--negative)" }}>{confirmResult.errorMessage}</p>
          )}
          <button className="btn" type="button" onClick={reset}>
            Import another screenshot
          </button>
        </div>
      )}
    </div>
  );
}
