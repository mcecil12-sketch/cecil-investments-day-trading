export function getRollingWindowMinutes(timeframe: string): number {
  switch (timeframe) {
    case "5Min":
      return 360;
    case "1Min":
    default:
      return 90;
  }
}

export function resolveEndIso(endTimeIso?: string): string {
  return endTimeIso
    ? new Date(endTimeIso).toISOString()
    : new Date().toISOString();
}
