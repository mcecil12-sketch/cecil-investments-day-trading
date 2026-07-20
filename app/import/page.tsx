import { prisma } from "@/lib/prisma";
import type { ImportBatchStatus } from "@/lib/generated/prisma";
import { formatDate } from "@/lib/format";
import { ImportForm } from "./ImportForm";
import { ScreenshotImportForm } from "./ScreenshotImportForm";
import { PdfImportForm } from "./PdfImportForm";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<ImportBatchStatus, string> = {
  COMPLETE: "var(--positive)",
  PARTIAL: "var(--accent)",
  FAILED: "var(--negative)",
  PENDING: "var(--text-muted)",
};

const SOURCE_LABEL: Record<string, string> = {
  pdf: "PDF Import",
  screenshot: "Screenshot",
  fidelity: "Fidelity CSV",
};

function sourceLabel(source: string, pdfAccountCounts: Map<string, number>, fileName: string): string {
  const label = SOURCE_LABEL[source] ?? source;
  if (source !== "pdf") return label;
  const count = pdfAccountCounts.get(fileName) ?? 1;
  return count > 1 ? `${label} (${count} accounts)` : label;
}

export default async function ImportPage() {
  const [batches, accounts] = await Promise.all([
    prisma.importBatch.findMany({
      orderBy: { uploadedAt: "desc" },
      take: 25,
      include: { account: { select: { name: true } } },
    }),
    prisma.account.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, externalId: true },
    }),
  ]);

  // PDF uploads create one ImportBatch per account, all sharing the source
  // file's name — group by fileName so the history table can show "PDF
  // Import (3 accounts)" on each row instead of just "PDF Import" x3.
  const pdfAccountCounts = new Map<string, number>();
  for (const batch of batches) {
    if (batch.source !== "pdf") continue;
    pdfAccountCounts.set(batch.fileName, (pdfAccountCounts.get(batch.fileName) ?? 0) + 1);
  }

  return (
    <div>
      <h1>Import</h1>
      <ImportForm />

      <h2>Upload Fidelity PDF (All Accounts)</h2>
      {accounts.length === 0 ? (
        <div className="card">
          <p style={{ color: "var(--text-muted)" }}>
            Add an account first — PDF positions need an account to import into.
          </p>
        </div>
      ) : (
        <PdfImportForm accounts={accounts} />
      )}

      <h2>Upload Screenshot</h2>
      {accounts.length === 0 ? (
        <div className="card">
          <p style={{ color: "var(--text-muted)" }}>
            Add an account first — screenshot positions need an account to import into.
          </p>
        </div>
      ) : (
        <ScreenshotImportForm accounts={accounts} />
      )}

      <h2>Import History</h2>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Source</th>
                <th>File</th>
                <th>As of</th>
                <th>Uploaded</th>
                <th>Status</th>
                <th>Rows</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id}>
                  <td>{batch.account.name}</td>
                  <td>{sourceLabel(batch.source, pdfAccountCounts, batch.fileName)}</td>
                  <td>{batch.fileName}</td>
                  <td className="mono">{formatDate(batch.asOfDate)}</td>
                  <td className="mono">{formatDate(batch.uploadedAt)}</td>
                  <td style={{ color: STATUS_COLOR[batch.status] }}>{batch.status}</td>
                  <td className="mono">{batch.rowCount}</td>
                </tr>
              ))}
              {batches.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ color: "var(--text-muted)" }}>
                    No imports yet — upload a PDF or CSV above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
