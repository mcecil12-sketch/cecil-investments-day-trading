// One-off cleanup for the duplicate Cecil Investments screenshot import.
//
// - IMG_0079.png: its holdings were incorrectly assigned to the "Cecil
//   Investments" account (a re-import of a snapshot that already existed for
//   that account/date, which doubled position values before the replace-on-
//   reimport fix landed). This deletes that batch's holdings + the batch
//   itself, scoped to the Cecil Investments account only.
// - IMG_0075.png: deleted entirely (holdings + batch) so Cecil Investments
//   can be re-imported clean.
//
// Usage:
//   DATABASE_URL="postgresql://..." node scripts/cleanup-duplicate-imports.mjs           # dry run, prints what would happen
//   DATABASE_URL="postgresql://..." node scripts/cleanup-duplicate-imports.mjs --confirm  # actually deletes
//
// Run against DIRECT_URL (unpooled) if DATABASE_URL (pooled) gives connection trouble.

import { PrismaClient } from "../lib/generated/prisma/index.js";

const prisma = new PrismaClient();
const confirm = process.argv.includes("--confirm");

async function deleteBatch(batch) {
  console.log(`  deleting batch ${batch.id} (${batch.holdings.length} holdings)`);
  if (!confirm) return;
  const batchIds = [batch.id];
  await prisma.benchmarkResult.deleteMany({ where: { importBatchId: { in: batchIds } } });
  await prisma.holding.deleteMany({ where: { importBatchId: { in: batchIds } } });
  await prisma.importBatch.delete({ where: { id: batch.id } });
}

async function main() {
  const targets = await prisma.importBatch.findMany({
    where: { fileName: { in: ["IMG_0079.png", "IMG_0075.png"] } },
    include: { account: true, holdings: { include: { instrument: true } } },
  });

  if (targets.length === 0) {
    console.log("No ImportBatch rows found for IMG_0079.png or IMG_0075.png.");
    return;
  }

  for (const batch of targets) {
    console.log(
      `\nBatch ${batch.id} — file=${batch.fileName} account="${batch.account.name}" (${batch.accountId}) asOfDate=${batch.asOfDate.toISOString()} status=${batch.status} holdings=${batch.holdings.length}`,
    );
    for (const h of batch.holdings) {
      console.log(`    ${h.instrument.symbol.padEnd(8)} qty=${h.quantity} value=${h.currentValue}`);
    }

    if (batch.fileName === "IMG_0079.png") {
      if (batch.account.name.trim().toLowerCase() === "cecil investments") {
        await deleteBatch(batch);
      } else {
        console.log(`  skipping — account is "${batch.account.name}", not Cecil Investments`);
      }
    } else if (batch.fileName === "IMG_0075.png") {
      await deleteBatch(batch);
    }
  }

  if (!confirm) {
    console.log("\nDry run only — re-run with --confirm to actually delete.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
