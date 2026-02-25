export type AutoManageConfig = {
  enabled: boolean;
  eodFlatten: boolean;
  cutLossEnabled: boolean;
  cutLossR: number;
  trailEnabled: boolean;
  trailStartR: number;
  trailPct: number;
  maxPerRun: number;
  replaceEnabled: boolean;
  replaceScoreDelta: number;
  replaceUnknownROverride: boolean;
};

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function getAutoManageConfig(): AutoManageConfig {
  const cutLossEnabledRaw =
    process.env.AUTO_MANAGE_CUT_LOSS_ENABLED ?? process.env.AUTO_CUT_LOSS_ENABLED ?? "0";
  const cutLossRRaw =
    process.env.AUTO_MANAGE_CUT_LOSS_R ?? process.env.AUTO_CUT_LOSS_R ?? "-1";

  return {
    enabled: process.env.AUTO_MANAGE_ENABLED === "1",
    eodFlatten: process.env.AUTO_MANAGE_EOD_FLATTEN === "1",
    cutLossEnabled: String(cutLossEnabledRaw) === "1",
    cutLossR: num(cutLossRRaw, -1.0),
    trailEnabled: process.env.AUTO_MANAGE_TRAIL_ENABLED === "1",
    trailStartR: num(process.env.AUTO_MANAGE_TRAIL_R, 2.5),
    trailPct: num(process.env.AUTO_MANAGE_TRAIL_PCT, 0.005),
    maxPerRun: Math.max(1, Math.floor(num(process.env.AUTO_MANAGE_MAX_PER_RUN, 50))),
    replaceEnabled: process.env.AUTO_MANAGE_REPLACE_ENABLED === "1",
    replaceScoreDelta: num(process.env.AUTO_MANAGE_REPLACE_SCORE_DELTA, 1.5),
    replaceUnknownROverride: process.env.AUTO_MANAGE_REPLACE_ALLOW_UNKNOWN_R_OVERRIDE === "1",
  };
}
