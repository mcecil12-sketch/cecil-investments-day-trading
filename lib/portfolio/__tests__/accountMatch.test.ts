import { describe, expect, it } from "vitest";
import { findCrossConsistencyMismatches, findMatchingAccountId } from "@/lib/portfolio/accountMatch";

describe("findMatchingAccountId", () => {
  it("matches by externalId over name", () => {
    const accounts = [
      { id: "a1", name: "Gifts and Trips", externalId: "Z29869942" },
      { id: "a2", name: "Verizon Mid-Atlantic", externalId: "90274" },
    ];
    expect(findMatchingAccountId(accounts, "Verizon Mid-Atlantic", "90274")).toBe("a2");
  });

  it("does not fuzzy/substring match on name", () => {
    const accounts = [
      { id: "a1", name: "Kennedy" },
      { id: "a2", name: "For Kennedy Trust" },
    ];
    expect(findMatchingAccountId(accounts, "Kennedy Account")).toBeUndefined();
  });
});

describe("findCrossConsistencyMismatches", () => {
  it("returns no mismatches when every section reports a distinct, stable account number", () => {
    const sections = [
      { accountId: "a1", accountNumber: "111" },
      { accountId: "a2", accountNumber: "222" },
    ];
    expect(findCrossConsistencyMismatches(sections).size).toBe(0);
  });

  it("flags a target account whose sections report different account numbers", () => {
    // Simulates one uploaded PDF where two sections both got routed to the
    // same DB account (e.g. a Positions section and a Performance-style
    // section within the same document) but disagree on the account number.
    const sections = [
      { accountId: "a1", accountNumber: "111" },
      { accountId: "a1", accountNumber: "999" },
    ];
    const mismatches = findCrossConsistencyMismatches(sections);
    expect(mismatches.has("a1")).toBe(true);
    expect(mismatches.get("a1")).toContain("111");
    expect(mismatches.get("a1")).toContain("999");
  });

  it("flags sections routed to different target accounts that claim the same account number", () => {
    // Simulates the Gifts and Trips / Verizon Mid-Atlantic style misattribution:
    // two different destination accounts both got a section claiming account
    // number 90274.
    const sections = [
      { accountId: "gifts-and-trips", accountNumber: "90274" },
      { accountId: "verizon-mid-atlantic", accountNumber: "90274" },
    ];
    const mismatches = findCrossConsistencyMismatches(sections);
    expect(mismatches.has("gifts-and-trips")).toBe(true);
    expect(mismatches.has("verizon-mid-atlantic")).toBe(true);
  });

  it("ignores sections with no reported account number", () => {
    const sections = [
      { accountId: "a1", accountNumber: null },
      { accountId: "a2" },
    ];
    expect(findCrossConsistencyMismatches(sections).size).toBe(0);
  });
});
