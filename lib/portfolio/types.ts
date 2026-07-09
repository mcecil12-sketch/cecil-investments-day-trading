export type AccountType = "taxable" | "401k" | "edp";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  locked: boolean;
}

export interface Position {
  symbol: string;
  name: string;
  quantity: number;
  costBasis: number;
  currentValue: number;
  percentOfAccount: number;
}

export interface Holding {
  account: Account;
  position: Position;
}

export interface Portfolio {
  accounts: Account[];
  holdings: Holding[];
  aggregateTotals: {
    totalCostBasis: number;
    totalCurrentValue: number;
    totalGainLoss: number;
  };
}

export type BenchmarkPeriod = "1y" | "3y" | "5y";

export interface BenchmarkResult {
  portfolioReturn: number;
  sp500Return: number;
  alpha: number;
  period: BenchmarkPeriod;
}
