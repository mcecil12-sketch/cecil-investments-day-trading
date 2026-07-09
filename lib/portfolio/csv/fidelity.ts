import { parse } from "csv-parse/sync";

export type FidelityInstrumentType = "STOCK" | "FUND" | "CASH";

export interface FidelityHoldingRow {
  symbol: string;
  description: string;
  quantity: number | null;
  lastPrice: number | null;
  currentValue: number;
  costBasisTotal: number | null;
  averageCostBasis: number | null;
  percentOfAccount: number | null;
  type: FidelityInstrumentType;
}

export interface FidelityAccountGroup {
  externalId: string;
  accountName: string;
  rows: FidelityHoldingRow[];
}

export interface ParsedFidelityCsv {
  asOfDate: Date | null;
  accounts: FidelityAccountGroup[];
  warnings: string[];
}

const HEADER_KEY_MAP: Record<string, string> = {
  "account number": "accountNumber",
  "account name": "accountName",
  symbol: "symbol",
  description: "description",
  quantity: "quantity",
  "last price": "lastPrice",
  "current value": "currentValue",
  "percent of account": "percentOfAccount",
  "cost basis total": "costBasisTotal",
  "average cost basis": "averageCostBasis",
  type: "type",
};

function normalizeHeaderCell(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || /^(n\/a|--|-)$/i.test(trimmed)) return null;
  const cleaned = trimmed.replace(/[$,%]/g, "").replace(/,/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function classifyType(rawType: string | undefined, symbol: string): FidelityInstrumentType {
  const t = (rawType ?? "").trim().toLowerCase();
  if (t.includes("cash")) return "CASH";
  if (t.includes("mutual fund") || t.includes("etf") || t.includes("index fund")) return "FUND";
  if (/\*\*$/.test(symbol.trim())) return "CASH";
  return "STOCK";
}

const NON_HOLDING_SYMBOLS = new Set(["pending activity"]);

/**
 * Parses Fidelity's standard "Portfolio Positions" export: a header row of
 * known columns, one data row per position (potentially spanning several
 * accounts in one file), followed by a "Date downloaded" line and a
 * disclaimer footer of arbitrary prose. relax_column_count tolerates the
 * footer having a different shape than the data rows.
 */
export function parseFidelityPositionsCsv(csvText: string): ParsedFidelityCsv {
  const warnings: string[] = [];
  const rawRows: string[][] = parse(csvText, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });

  const headerIndex = rawRows.findIndex(
    (row) => normalizeHeaderCell(row[0] ?? "") === "account number",
  );

  if (headerIndex === -1) {
    warnings.push("Could not find an 'Account Number' header row; no data was parsed.");
    return { asOfDate: null, accounts: [], warnings };
  }

  const header = rawRows[headerIndex].map(normalizeHeaderCell);
  const fieldIndex: Record<string, number> = {};
  for (const [rawKey, field] of Object.entries(HEADER_KEY_MAP)) {
    const idx = header.indexOf(rawKey);
    if (idx !== -1) fieldIndex[field] = idx;
  }

  const missingRequired = ["accountNumber", "accountName", "symbol", "currentValue"].filter(
    (f) => !(f in fieldIndex),
  );
  if (missingRequired.length > 0) {
    warnings.push(`Header is missing expected columns: ${missingRequired.join(", ")}`);
    return { asOfDate: null, accounts: [], warnings };
  }

  let asOfDate: Date | null = null;
  const groups = new Map<string, FidelityAccountGroup>();

  for (let i = headerIndex + 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    const cell = (idx: number | undefined) => (idx == null ? undefined : row[idx]);

    const accountNumber = cell(fieldIndex.accountNumber)?.trim();
    const accountName = cell(fieldIndex.accountName)?.trim();
    const symbol = cell(fieldIndex.symbol)?.trim();
    const currentValueRaw = cell(fieldIndex.currentValue);

    if (!accountNumber || !accountName) {
      const dateMatch = /date downloaded\s+([\d/]+)/i.exec(row.join(" "));
      if (dateMatch) {
        const parsedDate = new Date(dateMatch[1]);
        if (!Number.isNaN(parsedDate.getTime())) asOfDate = parsedDate;
      }
      continue;
    }

    if (!symbol || NON_HOLDING_SYMBOLS.has(symbol.toLowerCase())) {
      continue;
    }

    const currentValue = parseNumber(currentValueRaw);
    if (currentValue == null) {
      warnings.push(`Row ${i + 1}: skipped "${symbol}" — no numeric current value.`);
      continue;
    }

    const holdingRow: FidelityHoldingRow = {
      symbol,
      description: cell(fieldIndex.description)?.trim() ?? "",
      quantity: parseNumber(cell(fieldIndex.quantity)),
      lastPrice: parseNumber(cell(fieldIndex.lastPrice)),
      currentValue,
      costBasisTotal: parseNumber(cell(fieldIndex.costBasisTotal)),
      averageCostBasis: parseNumber(cell(fieldIndex.averageCostBasis)),
      percentOfAccount: parseNumber(cell(fieldIndex.percentOfAccount)),
      type: classifyType(cell(fieldIndex.type), symbol),
    };

    let group = groups.get(accountNumber);
    if (!group) {
      group = { externalId: accountNumber, accountName, rows: [] };
      groups.set(accountNumber, group);
    }
    group.rows.push(holdingRow);
  }

  return { asOfDate, accounts: Array.from(groups.values()), warnings };
}
