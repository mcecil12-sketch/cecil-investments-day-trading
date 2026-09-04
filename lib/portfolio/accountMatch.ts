export interface AccountOption {
  id: string;
  name: string;
  externalId?: string | null;
}

/**
 * Matches an extracted account name (and, when available, the source's
 * external account number) against known accounts, so import previews can
 * default to the right account instead of always falling back to the first
 * one. External-ID match takes priority since it's exact and unambiguous;
 * name matching is an exact-only fallback for accounts that don't have an
 * externalId recorded yet.
 *
 * Deliberately does NOT do substring/fuzzy name matching: two unrelated
 * accounts (e.g. a taxable account and a 401k) can each have a short,
 * generic name where one contains the other as a substring, which would
 * silently misroute one account's positions onto another. An uncertain
 * match should surface as "no match" (caller falls back to requiring an
 * explicit manual selection) rather than guessing.
 */
export function findMatchingAccountId(
  accounts: AccountOption[],
  extractedName: string,
  accountNumber?: string | null,
): string | undefined {
  if (accountNumber) {
    const byExternalId = accounts.find((account) => account.externalId && account.externalId === accountNumber);
    if (byExternalId) return byExternalId.id;
  }

  const normalize = (value: string) => value.trim().toLowerCase();
  const target = normalize(extractedName);
  const exact = accounts.find((account) => normalize(account.name) === target);
  return exact?.id;
}

export interface CrossConsistencySection {
  accountId: string;
  accountNumber?: string | null;
}

/**
 * Checks account-number consistency *across* the sections of a single
 * uploaded document — distinct from the self-consistency check in
 * app/api/import/pdf/confirm/route.ts, which only compares one section's
 * reported number against its target account's stored externalId.
 *
 * A single PDF can contain multiple sections; if the extraction or the
 * preview's account selection is wrong, two symptoms are possible that
 * self-consistency alone can't catch:
 *  - the same target account receives sections that reported different
 *    account numbers (contradicts itself about which account this is)
 *  - the same account number is reported by sections routed to different
 *    target accounts (one physical account can't be two destinations)
 *
 * Returns a map of accountId -> reason for every section that should be
 * blocked, so the caller can fail loudly instead of guessing which section
 * is right.
 */
export function findCrossConsistencyMismatches(sections: CrossConsistencySection[]): Map<string, string> {
  const numbersByAccountId = new Map<string, Set<string>>();
  const accountIdsByNumber = new Map<string, Set<string>>();

  for (const { accountId, accountNumber } of sections) {
    if (!accountNumber) continue;
    if (!numbersByAccountId.has(accountId)) numbersByAccountId.set(accountId, new Set());
    numbersByAccountId.get(accountId)!.add(accountNumber);

    if (!accountIdsByNumber.has(accountNumber)) accountIdsByNumber.set(accountNumber, new Set());
    accountIdsByNumber.get(accountNumber)!.add(accountId);
  }

  const mismatches = new Map<string, string>();

  for (const [accountId, numbers] of numbersByAccountId) {
    if (numbers.size > 1) {
      mismatches.set(
        accountId,
        `this PDF's sections report conflicting account numbers for the same target account: ${[...numbers].join(", ")}`,
      );
    }
  }

  for (const [number, accountIds] of accountIdsByNumber) {
    if (accountIds.size > 1) {
      for (const accountId of accountIds) {
        if (!mismatches.has(accountId)) {
          mismatches.set(
            accountId,
            `account number ${number} is reported by sections routed to ${accountIds.size} different target accounts in this PDF`,
          );
        }
      }
    }
  }

  return mismatches;
}
