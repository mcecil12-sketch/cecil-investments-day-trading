"use client";

import { useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import type { ScreenshotExtractionResult } from "@/lib/portfolio/screenshotImport";
import { findMatchingAccountId, type AccountOption } from "@/lib/portfolio/accountMatch";

type FileStatus = "pending" | "extracting" | "preview" | "imported" | "error";

interface QueueItem {
  id: string;
  file: File;
  status: FileStatus;
  accountName?: string;
  rowCount?: number;
  errorMessage?: string;
}

const STATUS_LABEL: Record<FileStatus, string> = {
  pending: "Pending",
  extracting: "Extracting…",
  preview: "Reviewing…",
  imported: "Imported",
  error: "Error",
};

const STATUS_COLOR: Record<FileStatus, string> = {
  pending: "var(--text-muted)",
  extracting: "var(--accent)",
  preview: "var(--accent)",
  imported: "var(--positive)",
  error: "var(--negative)",
};

let queueItemCounter = 0;

export function ScreenshotImportForm({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);

  function updateItem(id: string, patch: Partial<QueueItem>) {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function processFile(item: QueueItem) {
    updateItem(item.id, { status: "extracting" });
    try {
      const formData = new FormData();
      formData.set("file", item.file);
      const extractRes = await fetch("/api/import/screenshot", { method: "POST", body: formData });
      const extractBody = await extractRes.json();
      if (!extractRes.ok) throw new Error(extractBody.error ?? "Extraction failed");
      const extraction = extractBody as ScreenshotExtractionResult;

      updateItem(item.id, { status: "preview", accountName: extraction.accountName });

      const accountId = findMatchingAccountId(accounts, extraction.accountName);
      if (!accountId) {
        throw new Error(`No matching account found for "${extraction.accountName}" — import it individually instead`);
      }

      const confirmRes = await fetch("/api/import/screenshot/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          asOfDate: extraction.asOfDate,
          positions: extraction.positions,
          fileName: item.file.name,
        }),
      });
      const confirmBody = await confirmRes.json();
      if (!confirmRes.ok) throw new Error(confirmBody.error ?? "Import failed");
      if (confirmBody.errorMessage) throw new Error(confirmBody.errorMessage);

      updateItem(item.id, {
        status: "imported",
        accountName: confirmBody.accountName ?? extraction.accountName,
        rowCount: confirmBody.rowCount,
      });
    } catch (err) {
      updateItem(item.id, { status: "error", errorMessage: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Files are processed one at a time — sequentially, not in parallel — so a
   *  failed extraction doesn't waste a concurrent Claude request, and so the
   *  queue's per-row status always reflects work actually in flight. */
  async function processQueue(items: QueueItem[]) {
    for (const item of items) {
      await processFile(item);
    }
    router.refresh();
  }

  function enqueueFiles(files: File[]) {
    if (files.length === 0) return;
    const newItems: QueueItem[] = files.map((file) => ({
      id: `${Date.now()}-${queueItemCounter++}`,
      file,
      status: "pending",
    }));
    setQueue((prev) => [...prev, ...newItems]);
    processQueue(newItems);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    enqueueFiles(Array.from(event.dataTransfer.files ?? []));
  }

  function reset() {
    setQueue([]);
    if (inputRef.current) inputRef.current.value = "";
  }

  const importedCount = queue.filter((item) => item.status === "imported").length;
  const doneCount = queue.filter((item) => item.status === "imported" || item.status === "error").length;
  const allDone = queue.length > 0 && doneCount === queue.length;

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
        <div className="dropzone-title">Upload Screenshots</div>
        <div className="dropzone-hint">
          PNG or JPG of a brokerage account page — select multiple at once, Claude reads the positions for you
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          onChange={(e) => {
            enqueueFiles(Array.from(e.target.files ?? []));
          }}
        />
      </div>

      {queue.length > 0 && (
        <div className="card">
          <h2>Screenshot Queue</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Rows</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => (
                  <tr key={item.id}>
                    <td>{item.file.name}</td>
                    <td>{item.accountName ?? "—"}</td>
                    <td style={{ color: STATUS_COLOR[item.status] }}>
                      {STATUS_LABEL[item.status]}
                      {item.status === "error" && item.errorMessage && (
                        <div style={{ color: "var(--negative)", fontSize: "0.75rem", fontWeight: 400 }}>
                          {item.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="mono">{item.rowCount ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {allDone && (
            <div style={{ marginTop: "1rem" }}>
              <p>
                {importedCount} of {queue.length} account{queue.length === 1 ? "" : "s"} imported successfully
              </p>
              <button className="btn" type="button" onClick={reset}>
                Upload more screenshots
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
