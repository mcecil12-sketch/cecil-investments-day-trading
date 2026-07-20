/**
 * Simple NAV-delta return: (end - start) / start. This is not a true
 * time-weighted or money-weighted return — it doesn't account for deposits
 * or withdrawals between snapshots — but it's the honest figure available
 * from point-in-time position snapshots without transaction/cash-flow data.
 */
export function computeReturn(startValue: number, endValue: number): number | null {
  if (!Number.isFinite(startValue) || startValue === 0) return null;
  return (endValue - startValue) / startValue;
}

export function computeAlpha(
  portfolioReturn: number | null,
  sp500Return: number | null,
): number | null {
  if (portfolioReturn == null || sp500Return == null) return null;
  return portfolioReturn - sp500Return;
}
