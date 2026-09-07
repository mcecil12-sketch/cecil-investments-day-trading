"use client";

import { useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency } from "@/lib/format";
import type { ExtractedVzLtiTranche, VzLtiExtractionResult, VzLtiTrancheConflict } from "@/lib/portfolio/vzLtiImport";
import { mergeVzLtiTranches } from "@/lib/portfolio/vzLtiImport";
import type { AccountOption } from "@/lib/portfolio/accountMatch";

interface ConfirmResult {
  status: string;
  trancheCount: number;
  totalShares: number;
  vzPrice: number;
  totalValue: number;
}

interface FileEntry {
  id: string;
  file: File;
  status: "extracting" | "done" | "error";
  result?: VzLtiExtractionResult;
  error?: string;
}

type Phase = "idle" | "collecting" | "importing" | "done";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function extractFile(file: File): Promise<VzLtiExtractionResult> {
  const formData = new FormData();
  formData.set("file", file);
  const response = await fetch("/api/import/vz-lti", { method: "POST", body: formData });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Extraction failed");
  return body as VzLtiExtractionResult;
}

export function VzLtiImportForm({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setPhase("idle");
    setFiles([]);
    setConfirmResult(null);
    setError(null);
    setAsOfDate(todayIso());
    if (inputRef.current) inputRef.current.value = "";
  }

  async function addFiles(selected: File[]) {
    if (selected.length === 0) return;
    setError(null);
    setConfirmResult(null);
    setPhase("collecting");

    const entries: FileEntry[] = selected.map((file) => ({ id: String(nextId.current++), file, status: "extracting" }));
    setFiles((prev) => [...prev, ...entries]);

    await Promise.all(
      entries.map(async (entry) => {
        try {
          const result = await extractFile(entry.file);
          setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, status: "done", result } : f)));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, status: "error", error: message } : f)));
        }
      }),
    );
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  async function handleConfirm() {
    if (!accountId || merged.tranches.length === 0) return;
    setPhase("importing");
    setError(null);
    try {
      const response = await fetch("/api/import/vz-lti/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          asOfDate,
          tranches: merged.tranches,
          fileName: files.map((f) => f.file.name).join(", "),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Import failed");
      setConfirmResult(body as ConfirmResult);
      setPhase("done");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("collecting");
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files ?? []));
  }

  const extracting = files.some((f) => f.status === "extracting");
  const successfulResults = files.filter((f) => f.status === "done" && f.result).map((f) => f.result!.tranches);
  const merged = mergeVzLtiTranches(successfulResults);
  const totalShares = merged.tranches.reduce((sum, t) => sum + t.shares, 0);
  const busy = extracting || phase === "importing";

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
          {files.length > 0 ? `${files.length} screenshot${files.length === 1 ? "" : "s"} added` : "Upload Fidelity Stock Plans Screenshot(s)"}
        </div>
        <div className="dropzone-hint">
          The LTI grant/vesting schedule from Fidelity&apos;s Stock Plans tab — shares per grant cohort and vest
          year, not a flat balance. Balance is computed from shares × VZ&apos;s current price, not typed in. Add
          one screenshot per grant-year view if a single screenshot doesn&apos;t show every year — overlapping
          cohorts across screenshots are merged automatically.
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      {error && (
        <div className="card">
          <p style={{ color: "var(--negative)" }}>{error}</p>
        </div>
      )}

      {files.length > 0 && phase !== "done" && (
        <div className="card">
          <h2>Screenshots</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Status</th>
                  <th>Tranches</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id}>
                    <td>{f.file.name}</td>
                    <td>
                      {f.status === "extracting" && <span style={{ color: "var(--text-muted)" }}>Reading with Claude…</span>}
                      {f.status === "done" && <span style={{ color: "var(--positive)" }}>Extracted</span>}
                      {f.status === "error" && <span style={{ color: "var(--negative)" }}>{f.error}</span>}
                    </td>
                    <td className="mono">{f.result?.tranches.length ?? "—"}</td>
                    <td>
                      <button className="btn-secondary" type="button" onClick={() => removeFile(f.id)} disabled={busy}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {merged.conflicts.length > 0 && (
            <div style={{ marginTop: "1rem", color: "var(--negative)" }}>
              <p>
                <strong>Conflicting tranches — resolve before importing:</strong> the same cohort/vest date shows
                different share counts across screenshots. Remove the screenshot with the stale number and re-add
                the correct one.
              </p>
              <ul>
                {merged.conflicts.map((c: VzLtiTrancheConflict) => (
                  <li key={`${c.cohortLabel}-${c.vestDate}`}>
                    {c.cohortLabel} vesting {c.vestDate}: {c.shareValues.join(" vs. ")} shares
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!extracting && merged.tranches.length > 0 && (
            <>
              <h2 style={{ marginTop: "1.5rem" }}>Merged Grant Schedule</h2>
              <div style={{ marginBottom: "0.75rem", display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
                <div>
                  <label style={{ marginRight: "0.5rem" }}>Account:</label>
                  <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ marginRight: "0.5rem" }}>As of:</label>
                  <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
                </div>
              </div>

              <p style={{ color: "var(--text-muted)" }}>
                {merged.tranches.length} unvested third{merged.tranches.length === 1 ? "" : "s"}, {totalShares.toFixed(2)}{" "}
                total shares
              </p>

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
                    {merged.tranches
                      .slice()
                      .sort((a: ExtractedVzLtiTranche, b: ExtractedVzLtiTranche) => a.vestDate.localeCompare(b.vestDate) || a.cohortLabel.localeCompare(b.cohortLabel))
                      .map((t) => (
                        <tr key={`${t.cohortLabel}-${t.vestDate}`}>
                          <td>{t.cohortLabel}</td>
                          <td className="mono">{t.vestDate}</td>
                          <td className="mono">{t.shares.toFixed(2)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
                <button
                  className="btn"
                  type="button"
                  disabled={busy || !accountId || merged.conflicts.length > 0}
                  onClick={handleConfirm}
                >
                  {phase === "importing" ? "Importing…" : "Import Grant Schedule"}
                </button>
                <button className="btn-secondary" type="button" onClick={reset} disabled={busy}>
                  Start over
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {confirmResult && phase === "done" && (
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
