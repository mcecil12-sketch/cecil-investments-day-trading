import { describe, expect, it } from "vitest";
import { parseFidelityPositionsCsv } from "@/lib/portfolio/csv/fidelity";

const SAMPLE_CSV = [
  '"Account Number","Account Name","Symbol","Description","Quantity","Last Price","Last Price Change","Current Value","Today\'s Gain/Loss Dollar","Today\'s Gain/Loss Percent","Total Gain/Loss Dollar","Total Gain/Loss Percent","Percent Of Account","Cost Basis Total","Average Cost Basis","Type"',
  '"Z12345678","JOHN DOE - INDIVIDUAL","AAPL","APPLE INC, COMMON STOCK","10","$220.15","+$1.20","$2201.50","+$12.00","+0.55%","+$701.50","+46.77%","42.31%","$1500.00","$150.00",""',
  '"Z12345678","JOHN DOE - INDIVIDUAL","FXAIX","FIDELITY 500 INDEX FUND","25.123","$180.44","+$0.90","$4533.02","+$22.61","+0.50%","+$1033.02","+29.51%","57.30%","$3500.00","$139.30","Mutual Fund"',
  '"Z12345678","JOHN DOE - INDIVIDUAL","SPAXX**","FIDELITY GOVERNMENT MONEY MARKET","112.44","$1.00","$0.00","$112.44","$0.00","0.00%","n/a","n/a","1.42%","n/a","n/a","Cash"',
  '"Z12345678","JOHN DOE - INDIVIDUAL","Pending Activity","","","","","","","","","","","","",""',
  '"Z87654321","JANE DOE - ROTH IRA","VTI","VANGUARD TOTAL STOCK MARKET ETF","50","$255.00","+$2.10","$12750.00","+$105.00","+0.83%","+$2750.00","+27.5%","100.00%","$10000.00","$200.00","ETF"',
  "",
  "Date downloaded 07/09/2026 3:45 PM ET",
  "",
  '"The data and information in this spreadsheet is provided for informational purposes only, and should not be relied upon as the sole basis for any investment decision."',
].join("\n");

describe("parseFidelityPositionsCsv", () => {
  it("groups holdings by account and preserves account names", () => {
    const result = parseFidelityPositionsCsv(SAMPLE_CSV);

    expect(result.warnings).toEqual([]);
    expect(result.accounts).toHaveLength(2);

    const [johnAccount, janeAccount] = result.accounts;
    expect(johnAccount.externalId).toBe("Z12345678");
    expect(johnAccount.accountName).toBe("JOHN DOE - INDIVIDUAL");
    expect(janeAccount.externalId).toBe("Z87654321");
    expect(janeAccount.accountName).toBe("JANE DOE - ROTH IRA");
  });

  it("skips non-holding rows like Pending Activity", () => {
    const result = parseFidelityPositionsCsv(SAMPLE_CSV);
    const johnAccount = result.accounts[0];
    expect(johnAccount.rows.map((r) => r.symbol)).toEqual(["AAPL", "FXAIX", "SPAXX**"]);
  });

  it("strips currency/percent formatting and parses a quoted comma in the description", () => {
    const result = parseFidelityPositionsCsv(SAMPLE_CSV);
    const apple = result.accounts[0].rows[0];

    expect(apple.description).toBe("APPLE INC, COMMON STOCK");
    expect(apple.quantity).toBe(10);
    expect(apple.lastPrice).toBeCloseTo(220.15);
    expect(apple.currentValue).toBeCloseTo(2201.5);
    expect(apple.costBasisTotal).toBeCloseTo(1500);
    expect(apple.averageCostBasis).toBeCloseTo(150);
    expect(apple.percentOfAccount).toBeCloseTo(42.31);
  });

  it("treats n/a fields as null instead of NaN", () => {
    const result = parseFidelityPositionsCsv(SAMPLE_CSV);
    const cash = result.accounts[0].rows[2];

    expect(cash.costBasisTotal).toBeNull();
    expect(cash.averageCostBasis).toBeNull();
  });

  it("classifies stock, mutual fund, ETF, and cash rows", () => {
    const result = parseFidelityPositionsCsv(SAMPLE_CSV);
    const [aapl, fxaix, spaxx] = result.accounts[0].rows;
    const [vti] = result.accounts[1].rows;

    expect(aapl.type).toBe("STOCK");
    expect(fxaix.type).toBe("FUND");
    expect(spaxx.type).toBe("CASH");
    expect(vti.type).toBe("FUND");
  });

  it("extracts the as-of date from the 'Date downloaded' footer line", () => {
    const result = parseFidelityPositionsCsv(SAMPLE_CSV);
    expect(result.asOfDate).not.toBeNull();
    expect(result.asOfDate?.getFullYear()).toBe(2026);
    expect(result.asOfDate?.getMonth()).toBe(6); // July, 0-indexed
    expect(result.asOfDate?.getDate()).toBe(9);
  });

  it("ignores the disclaimer footer without producing warnings or a third account", () => {
    const result = parseFidelityPositionsCsv(SAMPLE_CSV);
    expect(result.accounts).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("returns a warning and no data when the header row is missing", () => {
    const result = parseFidelityPositionsCsv("not,a,fidelity,export\n1,2,3,4");
    expect(result.accounts).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns and skips rows with a non-numeric current value", () => {
    const csv = [
      SAMPLE_CSV.split("\n")[0],
      '"Z12345678","JOHN DOE - INDIVIDUAL","MSFT","MICROSOFT CORP","5","$400.00","","","","","","","10.00%","","",""',
    ].join("\n");

    const result = parseFidelityPositionsCsv(csv);
    expect(result.accounts).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("MSFT"))).toBe(true);
  });
});
