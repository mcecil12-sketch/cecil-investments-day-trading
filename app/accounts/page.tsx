import { prisma } from "@/lib/prisma";
import { NewAccountForm } from "./NewAccountForm";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const accounts = await prisma.account.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { holdings: true } } },
  });

  return (
    <div>
      <h1>Accounts</h1>
      <NewAccountForm />
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Institution</th>
              <th>External ID</th>
              <th>Locked</th>
              <th>Holdings</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>{account.name}</td>
                <td>{account.type}</td>
                <td>{account.institution}</td>
                <td>{account.externalId ?? "—"}</td>
                <td>{account.isLocked ? "Yes" : "No"}</td>
                <td>{account._count.holdings}</td>
              </tr>
            ))}
            {accounts.length === 0 && (
              <tr>
                <td colSpan={6} style={{ color: "var(--text-muted)" }}>
                  No accounts yet — add one above or upload a Fidelity CSV.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
