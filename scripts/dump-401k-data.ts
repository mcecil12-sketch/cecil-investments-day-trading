import { config } from "dotenv";
import path from "path";

config({ path: path.resolve(__dirname, "../.env.local") });

async function main() {
  const { prisma } = await import("../lib/prisma");

  const accounts = await prisma.account.findMany({
    where: { type: { in: ["VZ_SAVINGS_401K", "VZ_LEGACY_401K"] } },
    include: {
      planFundMenuEntries: true,
      importBatches: {
        where: { status: { in: ["COMPLETE", "PARTIAL"] } },
        orderBy: { asOfDate: "desc" },
        take: 1,
        include: {
          holdings: { include: { instrument: true } },
        },
      },
    },
  });

  for (const account of accounts) {
    console.log("\n=== ACCOUNT:", account.name, account.type, account.id, "===");
    console.log("-- Latest import batch holdings --");
    const latestBatch = account.importBatches[0];
    if (latestBatch) {
      for (const h of latestBatch.holdings) {
        console.log(
          JSON.stringify({
            symbol: h.instrument.symbol,
            name: h.instrument.name,
            currentValue: h.currentValue,
            asOfDate: h.asOfDate,
          }),
        );
      }
    } else {
      console.log("(no import batches)");
    }

    console.log("-- PlanFundMenuEntry rows (fund menu ingestion) --");
    for (const f of account.planFundMenuEntries) {
      console.log(
        JSON.stringify({
          fundName: f.fundName,
          ticker: f.ticker,
          assetClass: f.assetClass,
          oneYear: f.oneYear,
          threeYear: f.threeYear,
          fiveYear: f.fiveYear,
          tenYear: f.tenYear,
          isHeld: f.isHeld,
          asOfDate: f.asOfDate,
        }),
      );
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
