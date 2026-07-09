import { autoEnvBool, autoEnvNum } from "./config";
import { getEtDateString } from "@/lib/time/etDate";

export type GuardrailConfig = {
  enabled: boolean;
  maxOpenPositions: number;
  maxEntriesPerDay: number;
  cooldownAfterLossMin: number;
  tickerCooldownMin: number;
  maxConsecutiveFailures: number;
};

export function getGuardrailConfig(): GuardrailConfig {
  return {
    enabled: autoEnvBool("AUTO_ENTRY_ENABLED", true),
    maxOpenPositions: autoEnvNum("AUTO_ENTRY_MAX_OPEN_POSITIONS", 3),
    maxEntriesPerDay: autoEnvNum("AUTO_ENTRY_MAX_ENTRIES_PER_DAY", 5),
    cooldownAfterLossMin: autoEnvNum("AUTO_ENTRY_COOLDOWN_AFTER_LOSS_MIN", 20),
    tickerCooldownMin: autoEnvNum("AUTO_ENTRY_TICKER_COOLDOWN_MIN", 30),
    maxConsecutiveFailures: autoEnvNum("AUTO_ENTRY_MAX_CONSECUTIVE_FAILURES", 3),
  };
}

export function etDateString(date = new Date()) {
  return getEtDateString(date);
}

export function minutesSince(iso?: string | null) : number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 60000;
}
