/**
 * Some plan accounts (e.g. Verizon EDP) hold a company-match stock fund that
 * can't be reallocated. Its value counts toward the account's total, but
 * should never factor into a return/alpha calculation — matched here by
 * instrument identity rather than a stored flag, since the restriction is a
 * property of the fund itself, not of any particular import.
 */
const LOCKED_INSTRUMENT_NEEDLE = "VERIZON STOCK";

export function isLockedInstrument(instrument: { symbol: string; name: string | null }): boolean {
  const name = instrument.name?.toUpperCase() ?? "";
  const symbol = instrument.symbol.toUpperCase();
  return name.includes(LOCKED_INSTRUMENT_NEEDLE) || symbol.includes(LOCKED_INSTRUMENT_NEEDLE);
}
