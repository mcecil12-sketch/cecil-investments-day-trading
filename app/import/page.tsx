import { prisma } from "@/lib/prisma";
import type { ImportBatchStatus } from "@/lib/generated/prisma";
import { formatDate } from "@/lib/format";
import { ImportForm } from "./ImportForm";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<ImportBatchStatus, string> = {
  COMPLETE: "var(--positive)",
  PARTIAL: "var(--accent)",
  FAILED: "var(--negative)",
  PENDING: "var(--text-muted)",
};

export default async function ImportPage() {
  const batches = await prisma.importBatch.findMany({
    orderBy: { uploadedAt: "desc" },
    take: 25,
    include: { account: { select: { name: true } } },
  });

  return (
    <div>
      <h1>Import</h1>
      <ImportForm />

      <h2>Import History</h2>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
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
                  <td>{batch.fileName}</td>
                  <td className="mono">{formatDate(batch.asOfDate)}</td>
                  <td className="mono">{formatDate(batch.uploadedAt)}</td>
                  <td style={{ color: STATUS_COLOR[batch.status] }}>{batch.status}</td>
                  <td className="mono">{batch.rowCount}</td>
                </tr>
              ))}
              {batches.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ color: "var(--text-muted)" }}>
                    No imports yet — upload a CSV above.
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
