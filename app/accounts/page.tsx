import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { computeBenchmark } from "@/lib/benchmark/engine";
import type { BenchmarkComputation } from "@/lib/benchmark/engine";
import { alphaColor, formatCompactCurrency, formatCurrency, formatPercent } from "@/lib/format";
import { NewAccountForm } from "./NewAccountForm";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });

  let computation: BenchmarkComputation | null = null;
  try {
    computation = await computeBenchmark();
  } catch {
    // Value/alpha columns just fall back to "—" below if this fails.
  }

  const accountAlphaByAccount = new Map<string, number | null>();
  const accountValueByAccount = new Map<string, number>();
  const accountSplitByAccount = new Map<string, { locked: number; actionable: number }>();
  for (const result of computation?.accounts ?? []) {
    if (result.period !== "1y") continue;
    accountAlphaByAccount.set(result.accountId, result.alpha);
    accountValueByAccount.set(result.accountId, result.endValue);
    if (result.currentLockedValue > 0) {
      accountSplitByAccount.set(result.accountId, {
        locked: result.currentLockedValue,
        actionable: result.currentActionableValue,
      });
    }
  }

  return (
    <div>
      <h1>Accounts</h1>
      <NewAccountForm />

      <div className="card">
        {accounts.map((account) => {
          const value = accountValueByAccount.get(account.id) ?? null;
          const alpha = accountAlphaByAccount.get(account.id) ?? null;
          const split = accountSplitByAccount.get(account.id) ?? null;
          return (
            <Link
              href={`/accounts/${account.id}`}
              className={`account-row${account.isLocked ? " muted" : ""}`}
              key={account.id}
            >
              <div className="account-main">
                <div className="account-info">
                  <div className="account-name">{account.name}</div>
                  <div className="account-meta">
                    <span>{account.type}</span>
                    {account.isLocked && <span className="badge">Monitor Only</span>}
                  </div>
                </div>
                <div className="account-figures">
                  <div className="account-value">{formatCurrency(value)}</div>
                  {!account.isLocked && (
                    <div className="account-alpha" style={{ color: alphaColor(alpha) }}>
                      {formatPercent(alpha)} 1Y
                    </div>
                  )}
                </div>
              </div>
              {split && (
                <div className="account-split">
                  ({formatCompactCurrency(split.locked)} locked / {formatCompactCurrency(split.actionable)}{" "}
                  actionable)
                </div>
              )}
            </Link>
          );
        })}
        {accounts.length === 0 && (
          <p style={{ color: "var(--text-muted)" }}>
            No accounts yet — add one above or upload a Fidelity CSV.
          </p>
        )}
      </div>
    </div>
  );
}
