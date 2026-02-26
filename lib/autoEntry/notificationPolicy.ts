export type RuntimeEnvLabel = "prod" | "preview" | "dev" | "unknown";

export function getRuntimeEnvLabel(vercelEnv?: string | null, nodeEnv?: string | null): RuntimeEnvLabel {
  const ve = String(vercelEnv || "").trim().toLowerCase();
  if (ve === "production") return "prod";
  if (ve === "preview") return "preview";

  const ne = String(nodeEnv || "").trim().toLowerCase();
  if (ne === "development") return "dev";
  if (ne === "production") return "prod";
  if (ne) return "unknown";
  return "unknown";
}

export function shouldSendAutoEntryDisabledNotification(args: {
  vercelEnv?: string | null;
  allowPreviewNotifications?: string | null;
}): boolean {
  const env = String(args.vercelEnv || "").trim().toLowerCase();
  const allowPreview = String(args.allowPreviewNotifications || "").trim().toLowerCase() === "1";

  if (env === "preview" && !allowPreview) return false;
  return true;
}
