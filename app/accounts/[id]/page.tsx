import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { computeBenchmark } from "@/lib/benchmark/engine";
import { isLockedInstrument } from "@/lib/benchmark/lockedHoldings";
import { getLatestPrice, VZ_SYMBOL } from "@/lib/agents/marketData";
import { alphaColor, formatCompactCurrency, formatCurrency, formatDate, formatPercent } from "@/lib/format";
import { EditExternalId } from "./EditExternalId";
import { DeleteImportBatch } from "./DeleteImportBatch";

export const dynamic = "force-dynamic";

export default async function AccountDetailPage({ params }: { params: { id: string } }) {
  const account = await prisma.account.findUnique({ where: { id: params.id } });
  if (!account) notFound();

  const isVzLti = account.type === "VZ_LTI";

  // Filtered to batches that actually carry this account's value — some
  // import sources (e.g. the Performance PDF) legitimately create a
  // COMPLETE batch with no Holding/VzLtiTranche rows at all, and without
  // this filter that batch can out-sort the real snapshot once its asOfDate
  // catches up (see the identical fix in lib/benchmark/portfolioValue.ts).
  const latestBatch = await prisma.importBatch.findFirst({
    where: {
      accountId: account.id,
      status: { in: ["COMPLETE", "PARTIAL"] },
      ...(isVzLti ? { vzLtiTranches: { some: {} } } : { holdings: { some: {} } }),
    },
    orderBy: [{ asOfDate: "desc" }, { uploadedAt: "desc" }],
  });

  const holdings =
    !isVzLti && latestBatch
      ? await prisma.holding.findMany({
          where: { importBatchId: latestBatch.id },
          include: { instrument: true },
          orderBy: { currentValue: "desc" },
        })
      : [];

  const tranches =
    isVzLti && latestBatch
      ? await prisma.vzLtiTranche.findMany({ where: { importBatchId: latestBatch.id }, orderBy: { vestDate: "asc" } })
      : [];

  // VZ_LTI's value is repriced live (shares × VZ's current price) rather
  // than read from the frozen import-time currentValue — same repricing
  // lib/benchmark/portfolioValue.ts's toVzLtiSnapshotValue does for the
  // dashboard/benchmark total. Falls back to the frozen per-tranche value if
  // the live fetch fails, so a Yahoo outage doesn't break the page.
  let vzPrice: { price: number; asOf: Date } | null = null;
  if (isVzLti) {
    try {
      const live = await getLatestPrice(VZ_SYMBOL);
      vzPrice = { price: live.price, asOf: live.asOf };
    } catch {
      vzPrice = null;
    }
  }
  const trancheValue = (t: { shares: number; currentValue: number }) =>
    vzPrice ? t.shares * vzPrice.price : t.currentValue;

  const totalValue = isVzLti
    ? tranches.reduce((sum, t) => sum + trancheValue(t), 0)
    : holdings.reduce((sum, h) => sum + h.currentValue, 0);

  let alpha: number | null = null;
  let split: { locked: number; actionable: number } | null = null;
  try {
    const computation = await computeBenchmark();
    const result = computation.accounts.find((r) => r.accountId === account.id && r.period === "1y");
    if (result) {
      alpha = result.alpha;
      if (result.currentLockedValue > 0) {
        split = { locked: result.currentLockedValue, actionable: result.currentActionableValue };
      }
    }
  } catch {
    // Header just omits alpha if the benchmark computation fails.
  }

  return (
    <div>
      <Link href="/accounts" className="link-back">
        ← Accounts
      </Link>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          <div>
            <h1 style={{ margin: 0 }}>{account.name}</h1>
            <div className="account-meta">
              <span>{account.type}</span>
              <span>· {account.institution}</span>
              {account.isLocked && <span className="badge">Monitor Only</span>}
            </div>
            <div className="account-meta" style={{ marginTop: "0.25rem" }}>
              <EditExternalId accountId={account.id} externalId={account.externalId} />
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="mono" style={{ fontSize: "1.75rem", fontWeight: 800 }}>
              {formatCurrency(totalValue)}
            </div>
            {split ? (
              <div className="account-split">
                ({formatCompactCurrency(split.locked)} locked / {formatCompactCurrency(split.actionable)}{" "}
                actionable)
              </div>
            ) : (
              !account.isLocked && (
                <div className="account-alpha" style={{ color: alphaColor(alpha) }}>
                  {formatPercent(alpha)} 1Y alpha
                </div>
              )
            )}
          </div>
        </div>
        {latestBatch && (
          <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginBottom: 0, marginTop: "0.75rem" }}>
            As of {formatDate(latestBatch.asOfDate)}
          </p>
        )}
      </div>

      <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {isVzLti ? "Grant / Vesting Schedule" : "Positions"}
        {latestBatch && <DeleteImportBatch importBatchId={latestBatch.id} fileName={latestBatch.fileName} />}
      </h2>
      {isVzLti && (
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
          Balance drops each March as prior grants&apos; vesting thirds pay out net of tax to a separate account —
          an expected distribution, not a market loss.{" "}
          {vzPrice
            ? `Based on VZ @ $${vzPrice.price.toFixed(2)} (live).`
            : "VZ's live price couldn't be fetched right now — showing each tranche's value as of the last import instead."}
        </p>
      )}
      <div className="card">
        {isVzLti ? (
          tranches.length === 0 ? (
            <p style={{ color: "var(--text-muted)" }}>
              No grant schedule yet — import a Stock Plans screenshot for this account.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Cohort</th>
                    <th>Vest Date</th>
                    <th>Shares</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {tranches.map((tranche) => (
                    <tr key={tranche.id}>
                      <td>
                        {tranche.cohortLabel}
                        <div className="account-meta">{tranche.grantYear} grant</div>
                      </td>
                      <td className="mono">{formatDate(tranche.vestDate)}</td>
                      <td className="mono">{tranche.shares.toLocaleString()}</td>
                      <td className="mono">{formatCurrency(trancheValue(tranche))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : holdings.length === 0 ? (
          <p style={{ color: "var(--text-muted)" }}>
            No positions yet — import a statement for this account.
          </p>
        ) : (
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
                </tr>
              </thead>
              <tbody>
                {holdings.map((holding) => {
                  const gainLoss =
                    holding.costBasisTotal != null
                      ? holding.currentValue - holding.costBasisTotal
                      : null;
                  const gainLossPct =
                    holding.costBasisTotal != null && holding.costBasisTotal !== 0
                      ? gainLoss! / holding.costBasisTotal
                      : null;
                  const percentOfAccount =
                    holding.percentOfAccount ??
                    (totalValue > 0 ? (holding.currentValue / totalValue) * 100 : null);
                  const locked = isLockedInstrument(holding.instrument);
                  return (
                    <tr key={holding.id}>
                      <td>
                        <span className="mono">{holding.instrument.symbol}</span>
                        {locked && (
                          <span className="badge" style={{ marginLeft: "0.4rem" }}>
                            Locked
                          </span>
                        )}
                        <div className="account-meta">{holding.instrument.name}</div>
                      </td>
                      <td className="mono">{holding.quantity.toLocaleString()}</td>
                      <td className="mono">{formatCurrency(holding.currentValue)}</td>
                      <td className="mono">
                        {holding.costBasisTotal != null ? formatCurrency(holding.costBasisTotal) : "—"}
                      </td>
                      <td className="mono" style={{ color: alphaColor(gainLoss) }}>
                        {gainLoss != null ? formatCurrency(gainLoss) : "—"}
                        {gainLossPct != null && ` (${formatPercent(gainLossPct)})`}
                      </td>
                      <td className="mono">
                        {percentOfAccount != null ? `${percentOfAccount.toFixed(1)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
