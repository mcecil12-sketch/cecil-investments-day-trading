import { afterEach, describe, expect, it } from "vitest";
import { getAutoManageConfig } from "@/lib/autoManage/config";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getAutoManageConfig", () => {
  it("defaults replaceEnabled=true in paper mode", () => {
    delete process.env.AUTO_MANAGE_REPLACE_ENABLED;
    delete process.env.REPLACE_ENABLED;
    process.env.TRADING_MODE = "PAPER";

    const cfg = getAutoManageConfig();
    expect(cfg.replaceEnabled).toBe(true);
  });

  it("defaults replaceEnabled=false in live mode", () => {
    delete process.env.AUTO_MANAGE_REPLACE_ENABLED;
    delete process.env.REPLACE_ENABLED;
    process.env.TRADING_MODE = "LIVE";

    const cfg = getAutoManageConfig();
    expect(cfg.replaceEnabled).toBe(false);
  });
});
