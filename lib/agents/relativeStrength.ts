import { getPriceHistory, getSp500Series, type PricePoint } from "@/lib/agents/marketData";
import { getFundProxy, getKnownFundReturns, KNOWN_SP500_RETURNS, ACTIVE_FUND_NOTE } from "@/lib/agents/fundMappings";
import { getCurrentHoldings } from "@/lib/agents/holdings";
import { momentumOverDays, momentumTo100, sma, trendStrengthScore } from "@/lib/agents/technicals";

export interface RelativeStrengthEntry {
  symbol: string;
  name: string | null;
  currentValue: number;
  currentPrice: number;
  /** 0-100, momentum (60%) + trend strength (40%). */
  score: number;
  /** score minus the S&P 500's score over the same window — or, when reported returns are used, the fund's actual return minus the S&P's actual return (percentage points). */
  relativeScore: number;
  /** 1-year return, e.g. 0.18 = +18%. Sourced from the fund's own reported return when available, otherwise the 52-week price return. */
  momentum: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  sma50: number | null;
  sma200: number | null;
  accountIds: string[];
  /** Ticker whose price history was used for trend (50d/200d) in place of this holding's own, e.g. "SPY" for a 401k fund with no public price data. Null when the holding's own symbol had usable data. */
  proxySymbol: string | null;
  /** Human-readable disclosure of the reported-return/proxy/active-fund caveats. Null when neither applies. */
  note: string | null;
  /** Year-to-date return (decimal fraction) from the known-returns table, when on file. Null when unavailable — the composite score then falls back to 1Y momentum only. */
  ytdReturn: number | null;
  /** Set when YTD and 1Y returns disagree sharply (opposite sign, >15pp apart) — a signal to double-check before acting on the score. Null otherwise. */
  divergenceFlag: string | null;
}

export interface RelativeStrengthScoringResult {
  sp500: {
    score: number;
    momentum: number | null;
    aboveSma50: boolean | null;
    aboveSma200: boolean | null;
  };
  /** Every holding that could be scored, unfiltered — the full universe behind topHoldings/underperformers/candidates. */
  scored: RelativeStrengthEntry[];
  skipped: Array<{ symbol: string; reason: string }>;
}

export interface RelativeStrengthOutput {
  generatedAt: string;
  sp500: RelativeStrengthScoringResult["sp500"];
  /** Every scored holding, sorted by score descending — the comprehensive universe behind the three curated buckets below. The full report renders this so no position is ever hidden by the top/bottom/candidate selection. */
  allHoldings: RelativeStrengthEntry[];
  topHoldings: RelativeStrengthEntry[];
  underperformers: RelativeStrengthEntry[];
  candidates: RelativeStrengthEntry[];
  skipped: Array<{ symbol: string; reason: string }>;
}

/** Composite-return weights applied when a fund's known returns include a YTD figure — 20% YTD, 30% 1Y, 30% 3Y, 20% 5Y. Without a YTD figure, scoring falls back to 1Y momentum only (the pre-existing behavior). */
const YTD_WEIGHT = 0.2;
const ONE_YEAR_WEIGHT = 0.3;
const THREE_YEAR_WEIGHT = 0.3;
const FIVE_YEAR_WEIGHT = 0.2;

/** Minimum gap (percentage points, as a fraction) between YTD and 1Y returns, in opposite directions, before it's worth flagging as a divergence to verify. */
const DIVERGENCE_THRESHOLD = 0.15;

interface ScoredSeries {
  currentPrice: number;
  momentum: number | null;
  sma50: number | null;
  sma200: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  score: number;
}

function scoreSeries(rawPoints: PricePoint[]): ScoredSeries {
  const points = [...rawPoints].sort((a, b) => a.date.getTime() - b.date.getTime());
  const last = points[points.length - 1];
  const momentum = momentumOverDays(points, 364);
  const sma50 = sma(points, 50);
  const sma200 = sma(points, 200);
  const trend = trendStrengthScore(last.close, sma50, sma200);
  const momentumScore = momentumTo100(momentum);
  const score = Math.max(0, Math.min(100, Math.round(momentumScore * 0.6 + trend * 0.4)));

  return {
    currentPrice: last.close,
    momentum,
    sma50,
    sma200,
    aboveSma50: sma50 == null ? null : last.close > sma50,
    aboveSma200: sma200 == null ? null : last.close > sma200,
    score,
  };
}

/**
 * Scores every current holding 0-100 on momentum (60%) + trend strength vs.
 * its 50/200-day moving averages (40%), relative to the S&P 500 over the
 * same window. For 401k funds with no public ticker, falls back to a proxy
 * ETF's price history (see fundMappings.ts) for trend, and to the fund's own
 * manually reported return for momentum when one is on file — the reported
 * return is the fund's actual performance, so it takes priority over any
 * proxy approximation. When a YTD figure is also on file, momentum becomes a
 * 20/30/30/20 YTD/1Y/3Y/5Y composite return instead of 1Y alone.
 */
export async function scoreCurrentHoldings(): Promise<RelativeStrengthScoringResult> {
  const [sp500Points, holdings] = await Promise.all([getSp500Series(), getCurrentHoldings()]);
  const sp500 = scoreSeries(sp500Points);

  const scored: RelativeStrengthEntry[] = [];
  const skipped: Array<{ symbol: string; reason: string }> = [];

  for (const holding of holdings) {
    try {
      let points: PricePoint[];
      let proxySymbol: string | null = null;
      let isActiveFund = false;

      try {
        ({ points } = await getPriceHistory(holding.symbol));
      } catch {
        const proxy = getFundProxy(holding.symbol, holding.name);
        if (!proxy) {
          skipped.push({ symbol: holding.symbol, reason: "No proxy available" });
          continue;
        }
        proxySymbol = proxy.proxy;
        isActiveFund = proxy.isActive;
        ({ points } = await getPriceHistory(proxySymbol));
      }

      const priceScored = scoreSeries(points);
      const knownReturns = getKnownFundReturns(holding.symbol, holding.name);
      const noteParts: string[] = [];

      let momentum = priceScored.momentum;
      let score = priceScored.score;
      let relativeScore = score - sp500.score;
      let ytdReturn: number | null = null;
      let divergenceFlag: string | null = null;

      if (knownReturns) {
        momentum = knownReturns.oneYear;
        ytdReturn = knownReturns.ytdReturn ?? null;

        // Composite return blends YTD/1Y/3Y/5Y when a YTD figure is on file;
        // otherwise scoring falls back to 1Y momentum only, same as before.
        const compositeReturn =
          ytdReturn != null
            ? ytdReturn * YTD_WEIGHT +
              knownReturns.oneYear * ONE_YEAR_WEIGHT +
              knownReturns.threeYear * THREE_YEAR_WEIGHT +
              knownReturns.fiveYear * FIVE_YEAR_WEIGHT
            : knownReturns.oneYear;

        const momentumScore = momentumTo100(compositeReturn);
        const trend = trendStrengthScore(priceScored.currentPrice, priceScored.sma50, priceScored.sma200);
        score = Math.max(0, Math.min(100, Math.round(momentumScore * 0.6 + trend * 0.4)));
        relativeScore = Math.round((knownReturns.oneYear - KNOWN_SP500_RETURNS.oneYear) * 100);
        noteParts.push(ytdReturn != null ? "via reported returns (YTD/1Y/3Y/5Y composite)" : "via reported returns");
        if (proxySymbol) noteParts.push(`trend via ${proxySymbol} proxy`);

        if (ytdReturn != null) {
          const oppositeSigns = (ytdReturn > 0 && knownReturns.oneYear < 0) || (ytdReturn < 0 && knownReturns.oneYear > 0);
          if (oppositeSigns && Math.abs(ytdReturn - knownReturns.oneYear) > DIVERGENCE_THRESHOLD) {
            divergenceFlag = "YTD/1Y divergence — verify before acting";
          }
        }
      } else if (proxySymbol) {
        noteParts.push(`via ${proxySymbol} proxy`);
      }
      if (isActiveFund) noteParts.push(ACTIVE_FUND_NOTE);

      scored.push({
        symbol: holding.symbol,
        name: holding.name,
        currentValue: holding.currentValue,
        currentPrice: priceScored.currentPrice,
        score,
        relativeScore,
        momentum,
        aboveSma50: priceScored.aboveSma50,
        aboveSma200: priceScored.aboveSma200,
        sma50: priceScored.sma50,
        sma200: priceScored.sma200,
        accountIds: holding.accounts.map((a) => a.accountId),
        proxySymbol,
        note: noteParts.length > 0 ? noteParts.join(" — ") : null,
        ytdReturn,
        divergenceFlag,
      });
    } catch (err) {
      skipped.push({ symbol: holding.symbol, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    sp500: {
      score: sp500.score,
      momentum: sp500.momentum,
      aboveSma50: sp500.aboveSma50,
      aboveSma200: sp500.aboveSma200,
    },
    scored,
    skipped,
  };
}

/**
 * Buckets the full scored universe into top performers, underperformers, and
 * next-tier candidates to watch — a curated top/bottom/middle-3 selection
 * used to build a manageable set of draft Action Items. This selection is
 * deliberately small (it feeds the CIO action list), so it's not where a
 * position "disappears": every scored holding, however it buckets, is also
 * returned unfiltered in `allHoldings` for the full report.
 */
export async function runRelativeStrengthAgent(): Promise<RelativeStrengthOutput> {
  const { sp500, scored, skipped } = await scoreCurrentHoldings();

  const sortedDesc = [...scored].sort((a, b) => b.score - a.score);
  const topHoldings = sortedDesc.slice(0, 3);
  const rest = sortedDesc.slice(3);
  const bottomCount = Math.min(3, rest.length);
  const underperformers = rest.slice(rest.length - bottomCount).reverse();
  const candidates = rest.slice(0, rest.length - bottomCount).slice(0, 3);

  return {
    generatedAt: new Date().toISOString(),
    sp500,
    allHoldings: sortedDesc,
    topHoldings,
    underperformers,
    candidates,
    skipped,
  };
}
