import ExcelJS from "exceljs";

const SSGA_HOLDINGS_URL = (etfTicker: string) =>
  `https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${etfTicker.toLowerCase()}.xlsx`;

/** Real equity tickers only: 1-5 uppercase letters, optional share-class suffix (e.g. BRK-B). Excludes SSGA's cash-sweep rows (ticker "-") and futures-contract rows (e.g. "IXPU6") from the full-holdings export. */
const VALID_TICKER = /^[A-Z]{1,5}(-[A-Z])?$/;

export interface SectorHolding {
  symbol: string;
  name: string;
  weight: number;
}

/**
 * Fetches and parses the official full-holdings export for a SPDR sector
 * ETF directly from State Street (ssga.com) — the authoritative source for
 * accurate, current constituent weights, rather than a third-party
 * aggregator. The header row position varies slightly release to release (a
 * few fixed disclosure rows precede it), so the "Name"/"Ticker"/"Weight"
 * header is located by content rather than a hardcoded row number. Returns
 * real constituents only, sorted by weight descending (SSGA already sorts
 * this way, but the sort is defensive).
 */
export async function fetchSectorHoldings(etfTicker: string): Promise<SectorHolding[]> {
  const url = SSGA_HOLDINGS_URL(etfTicker);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; portfolio-benchmark/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`SSGA holdings request failed for ${etfTicker}: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error(`SSGA holdings file for ${etfTicker} had no worksheet`);
  }

  let headerRowNumber: number | null = null;
  let nameCol = -1;
  let tickerCol = -1;
  let weightCol = -1;

  sheet.eachRow((row, rowNumber) => {
    if (headerRowNumber != null) return;
    const values = row.values as unknown[];
    const foundName = values.findIndex((v) => v === "Name");
    const foundTicker = values.findIndex((v) => v === "Ticker");
    const foundWeight = values.findIndex((v) => v === "Weight");
    if (foundName > 0 && foundTicker > 0 && foundWeight > 0) {
      headerRowNumber = rowNumber;
      nameCol = foundName;
      tickerCol = foundTicker;
      weightCol = foundWeight;
    }
  });

  if (headerRowNumber == null) {
    throw new Error(`SSGA holdings file for ${etfTicker} did not contain the expected Name/Ticker/Weight header row`);
  }

  const holdings: SectorHolding[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= (headerRowNumber as number)) return;
    const values = row.values as unknown[];
    const rawTicker = values[tickerCol];
    const rawName = values[nameCol];
    const rawWeight = values[weightCol];
    if (typeof rawTicker !== "string" || typeof rawWeight !== "number") return;
    const symbol = rawTicker.trim().toUpperCase();
    if (!VALID_TICKER.test(symbol)) return;
    holdings.push({
      symbol,
      name: typeof rawName === "string" ? rawName.trim() : symbol,
      weight: rawWeight,
    });
  });

  if (holdings.length === 0) {
    throw new Error(`SSGA holdings file for ${etfTicker} yielded no usable equity rows`);
  }

  holdings.sort((a, b) => b.weight - a.weight);
  return holdings;
}
