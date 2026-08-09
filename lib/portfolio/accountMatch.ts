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
