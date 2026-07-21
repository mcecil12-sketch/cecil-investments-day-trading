import "dotenv/config";
import { getPriceHistory } from "../lib/agents/marketData";
import { blendedMomentum, scorePriceSeries } from "../lib/agents/technicals";
import { formatPercent } from "../lib/format";

const WATCHLIST = ["PSX", "MPC", "VLO", "UNH", "LLY", "JNJ", "MRK", "AAPL", "AMD", "ASML"];

async function main() {
  const rows: Array<{
    symbol: string;
    m3: string;
    m6: string;
    m12: string;
    momentumScore: string;
    finalScore: number;
  }> = [];

  for (const symbol of WATCHLIST) {
    const { points } = await getPriceHistory(symbol);
    const blend = blendedMomentum(points);
    const scored = scorePriceSeries(points);
    rows.push({
      symbol,
      m3: formatPercent(blend.momentum3m),
      m6: formatPercent(blend.momentum6m),
      m12: formatPercent(blend.momentum12to1),
      momentumScore: blend.score.toFixed(1),
      finalScore: scored.score,
    });
  }

  console.table(rows);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
