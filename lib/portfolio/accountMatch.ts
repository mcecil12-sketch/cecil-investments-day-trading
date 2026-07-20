export interface AccountOption {
  id: string;
  name: string;
  externalId?: string | null;
}

/**
 * Matches an extracted account name (and, when available, the source's
 * external account number) against known accounts, so import previews can
 * default to the right account instead of always falling back to the first
 * one. External-ID match takes priority since it's exact; name matching is
 * a normalized/fuzzy fallback.
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
  if (exact) return exact.id;
  const partial = accounts.find(
    (account) => normalize(account.name).includes(target) || target.includes(normalize(account.name)),
  );
  return partial?.id;
}
