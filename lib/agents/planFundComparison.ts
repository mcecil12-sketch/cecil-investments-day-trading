import { prisma } from "@/lib/prisma";

/**
 * Style-based peer grouping for 401k plan fund menus — finer than the plan's
 * own assetClass field (e.g. "Stock Investments" alone lumps emerging
 * markets, REITs, and a single-stock fund together), so a held fund is only
 * ever compared against genuine same-style peers within its own plan.
 */
export type FundCategory =
  | "target-date"
  | "us-large-cap"
  | "us-small-cap"
  | "emerging-markets"
  | "intl-developed"
  | "active-growth"
  | "reit"
  | "company-stock"
  | "bond"
  | "short-term-cash"
  | "other";

function categorizeFund(fundName: string, assetClass: string | null): FundCategory {
  const name = fundName.toUpperCase();
  if (/^VERIZON 20\d\d FUND$/.test(name) || name === "VERIZON RETIRE INC" || name === "RET INCOME & INVEST") {
    return "target-date";
  }
  if (name === "AGGRESS GRW MA" || name === "MAGELLAN PORTFOLIO") return "active-growth";
  if (name === "US LARGE CO INDEX" || name === "PASS US EQ INDX MA") return "us-large-cap";
  if (name === "US SMALL COMPANY" || name === "SMALL CAP EQTY INDX" || name === "ACTV US SM CAP MA") return "us-small-cap";
  if (name === "EMERGING MARKETS") return "emerging-markets";
  if (["INTL COMPANY", "INTL COMPANY INDEX", "ACTV INTL EQ MA", "PASS INTL EQ IND MA", "DIVERSIFIED INTL"].includes(name)) {
    return "intl-developed";
  }
  if (name === "REIT FUND" || name === "FIAM REIT CP MA") return "reit";
  if (name === "VERIZON STOCK FUND" || name === "VZ CO STK FUND MA") return "company-stock";
  if (assetClass === "Bond Investments") return "bond";
  if (assetClass === "Short Term Investments" || name === "MM PORTFOLIO") return "short-term-cash";
  return "other";
}

export interface PlanFundMenuRow {
  fundName: string;
  assetClass: string | null;
  oneYear: number | null;
  threeYear: number | null;
  fiveYear: number | null;
  tenYear: number | null;
  isHeld: boolean;
  category: FundCategory;
}

type Horizon = "oneYear" | "threeYear" | "fiveYear";
const HORIZONS: Horizon[] = ["oneYear", "threeYear", "fiveYear"];

function compareOnAvailableHorizons(a: PlanFundMenuRow, b: PlanFundMenuRow) {
  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  const horizons: Horizon[] = [];
  for (const h of HORIZONS) {
    const av = a[h];
    const bv = b[h];
    if (av == null || bv == null) continue;
    horizons.push(h);
    if (av > bv) aWins++;
    else if (bv > av) bWins++;
    else ties++;
  }
  return { aWins, bWins, ties, horizons };
}

export type PeerVerdictKind = "peer-confirmed-better" | "held-confirmed-better" | "mixed" | "peer-short-history" | "no-overlap";

export interface PeerComparison {
  peer: PlanFundMenuRow;
  verdictKind: PeerVerdictKind;
  detail: string;
}

function buildPeerComparison(fund: PlanFundMenuRow, peer: PlanFundMenuRow): PeerComparison {
  const cmp = compareOnAvailableHorizons(fund, peer);
  const isShortHistoryPeer = peer.threeYear == null || peer.fiveYear == null;

  if (cmp.horizons.length === 0) {
    return { peer, verdictKind: "no-overlap", detail: "No overlapping horizons with data to compare." };
  }
  if (cmp.bWins === cmp.horizons.length && isShortHistoryPeer) {
    return {
      peer,
      verdictKind: "peer-short-history",
      detail: `Leads on the only horizon(s) on file (${cmp.horizons.join(", ")}), but lacks 3Y/5Y history — recently added to this plan's menu, not unproven. Not enough track record yet to call this a confirmed alternative.`,
    };
  }
  if (cmp.bWins === cmp.horizons.length) {
    return {
      peer,
      verdictKind: "peer-confirmed-better",
      detail: `${peer.fundName} beats ${fund.fundName} on all ${cmp.horizons.length} comparable horizon(s) (${cmp.horizons.join(", ")}). Genuine same-plan alternative.`,
    };
  }
  if (cmp.aWins === cmp.horizons.length) {
    return {
      peer,
      verdictKind: "held-confirmed-better",
      detail: `${fund.fundName} already beats ${peer.fundName} on all ${cmp.horizons.length} comparable horizon(s). No swap indicated vs this peer.`,
    };
  }
  return {
    peer,
    verdictKind: "mixed",
    detail: `Mixed: ${fund.fundName} wins ${cmp.aWins}, ${peer.fundName} wins ${cmp.bWins}, ties ${cmp.ties} (of ${cmp.horizons.length} comparable horizons). No clear winner — depends on time horizon.`,
  };
}

export interface HeldFundComparison {
  fund: PlanFundMenuRow;
  peers: PeerComparison[];
  /** True only when the held fund beats every same-category peer on every comparable horizon. */
  isBestInCategory: boolean;
  summary: string;
}

function buildSummary(fund: PlanFundMenuRow, peers: PlanFundMenuRow[], peerComparisons: PeerComparison[], isBestInCategory: boolean): string {
  if (peers.length === 0) {
    return `Sole fund in the ${fund.category} category for this plan — no genuine same-plan alternative exists.`;
  }
  if (isBestInCategory) {
    return `Already the best performer in its category on every comparable horizon. No swap recommended.`;
  }
  if (peerComparisons.some((pc) => pc.verdictKind === "peer-confirmed-better")) {
    return `A genuinely better same-plan alternative exists — see below.`;
  }
  if (peerComparisons.some((pc) => pc.verdictKind === "peer-short-history")) {
    return `A newer same-plan peer leads on limited data, but lacks the history to confirm — see below.`;
  }
  return `Mixed results vs. same-plan peers — no clear winner across horizons.`;
}

export interface PlanFundComparisonResult {
  accountId: string;
  accountName: string;
  accountType: string;
  totalFunds: number;
  heldComparisons: HeldFundComparison[];
  /** Set when heldComparisons were copied from another account's own analysis rather than derived from this account's own PlanFundMenuEntry rows. */
  mirroredFrom?: { accountId: string; accountName: string };
}

/** The Verizon EDP account's flexible (non-locked) portion draws from this same three-fund universe as the Savings Plan. EDP has no fund menu of its own imported, so its recommendation is mirrored from the Savings Plan's own analysis rather than computed independently. */
const EDP_MIRRORED_FUND_NAMES = new Set(["US LARGE CO INDEX", "EMERGING MARKETS", "US SMALL COMPANY"]);

export async function buildPlanFundComparisons(): Promise<PlanFundComparisonResult[]> {
  const accounts = await prisma.account.findMany({
    where: { type: { in: ["VZ_SAVINGS_401K", "VZ_LEGACY_401K", "VZ_EDP"] } },
    include: { planFundMenuEntries: true },
  });

  const results: PlanFundComparisonResult[] = accounts.map((account) => {
    const rows: PlanFundMenuRow[] = account.planFundMenuEntries.map((f) => ({
      fundName: f.fundName,
      assetClass: f.assetClass,
      oneYear: f.oneYear,
      threeYear: f.threeYear,
      fiveYear: f.fiveYear,
      tenYear: f.tenYear,
      isHeld: f.isHeld,
      category: categorizeFund(f.fundName, f.assetClass),
    }));

    const heldComparisons: HeldFundComparison[] = rows
      .filter((r) => r.isHeld)
      .map((fund) => {
        const peers = rows.filter((r) => r.category === fund.category && r.fundName !== fund.fundName);
        const peerComparisons = peers.map((peer) => buildPeerComparison(fund, peer));
        const isBestInCategory = peers.length > 0 && peerComparisons.every((pc) => pc.verdictKind === "held-confirmed-better");
        return {
          fund,
          peers: peerComparisons,
          isBestInCategory,
          summary: buildSummary(fund, peers, peerComparisons, isBestInCategory),
        };
      });

    return {
      accountId: account.id,
      accountName: account.name,
      accountType: account.type,
      totalFunds: rows.length,
      heldComparisons,
    };
  });

  const edp = results.find((r) => r.accountType === "VZ_EDP");
  const savingsPlan = results.find((r) => r.accountType === "VZ_SAVINGS_401K");
  if (edp && savingsPlan && edp.totalFunds === 0) {
    edp.heldComparisons = savingsPlan.heldComparisons.filter((hc) => EDP_MIRRORED_FUND_NAMES.has(hc.fund.fundName));
    edp.totalFunds = edp.heldComparisons.length;
    edp.mirroredFrom = { accountId: savingsPlan.accountId, accountName: savingsPlan.accountName };
  }

  return results;
}
