export type AutoManageConfig = {
  enabled: boolean;
  eodFlatten: boolean;
  trailEnabled: boolean;
  trailStartR: number;
  trailPct: number;
  maxPerRun: number;
};

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function getAutoManageConfig(): AutoManageConfig {
  return {
    enabled: process.env.AUTO_MANAGE_ENABLED === "1",
    eodFlatten: process.env.AUTO_MANAGE_EOD_FLATTEN === "1",
    trailEnabled: process.env.AUTO_MANAGE_TRAIL_ENABLED === "1",
    trailStartR: num(process.env.AUTO_MANAGE_TRAIL_R, 2.5),
    trailPct: num(process.env.AUTO_MANAGE_TRAIL_PCT, 0.005),
    maxPerRun: Math.max(1, Math.floor(num(process.env.AUTO_MANAGE_MAX_PER_RUN, 50))),
  };
}
