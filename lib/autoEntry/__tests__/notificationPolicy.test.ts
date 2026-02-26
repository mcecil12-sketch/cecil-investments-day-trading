import { describe, expect, it } from "vitest";
import { shouldSendAutoEntryDisabledNotification } from "@/lib/autoEntry/notificationPolicy";

describe("shouldSendAutoEntryDisabledNotification", () => {
  it("skips notifications on preview by default", () => {
    const allowed = shouldSendAutoEntryDisabledNotification({
      vercelEnv: "preview",
      allowPreviewNotifications: "0",
    });
    expect(allowed).toBe(false);
  });

  it("allows notifications on preview when override flag is set", () => {
    const allowed = shouldSendAutoEntryDisabledNotification({
      vercelEnv: "preview",
      allowPreviewNotifications: "1",
    });
    expect(allowed).toBe(true);
  });

  it("allows notifications in production", () => {
    const allowed = shouldSendAutoEntryDisabledNotification({
      vercelEnv: "production",
      allowPreviewNotifications: "0",
    });
    expect(allowed).toBe(true);
  });
});
