import { describe, expect, it } from "vitest";
import { shouldSendAutoEntryDisabledNotification } from "@/lib/autoEntry/disabledNotification";

describe("shouldSendAutoEntryDisabledNotification", () => {
  it("skips in preview by default", () => {
    process.env.ALLOW_PREVIEW_NOTIFICATIONS = "0";
    expect(shouldSendAutoEntryDisabledNotification("preview")).toBe(false);
  });

  it("allows in preview when explicit override is enabled", () => {
    process.env.ALLOW_PREVIEW_NOTIFICATIONS = "1";
    expect(shouldSendAutoEntryDisabledNotification("preview")).toBe(true);
  });

  it("allows in production", () => {
    process.env.ALLOW_PREVIEW_NOTIFICATIONS = "0";
    expect(shouldSendAutoEntryDisabledNotification("production")).toBe(true);
  });
});
