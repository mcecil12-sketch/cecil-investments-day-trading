/**
 * GitHub Write Capability Check — Phase 4
 *
 * Exposes a capability check for whether GitHub write operations
 * are configured and available.
 */

import type { GitHubWriteCapability } from "@/lib/agents/types";

export function checkGitHubWriteCapability(): GitHubWriteCapability {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  const installationId = process.env.GITHUB_INSTALLATION_ID?.trim();
  const repoOwner = process.env.GITHUB_REPO_OWNER?.trim();
  const repoName = process.env.GITHUB_REPO_NAME?.trim();

  const missing: string[] = [];
  if (!appId) missing.push("GITHUB_APP_ID");
  if (!privateKey) missing.push("GITHUB_APP_PRIVATE_KEY");
  if (!installationId) missing.push("GITHUB_INSTALLATION_ID");
  if (!repoOwner) missing.push("GITHUB_REPO_OWNER");
  if (!repoName) missing.push("GITHUB_REPO_NAME");

  if (missing.length > 0) {
    return {
      writeEnabled: false,
      reason: `Missing env vars: ${missing.join(", ")}`,
    };
  }

  return { writeEnabled: true };
}

export function getGitHubBranchName(taskId: string): string {
  const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const shortId = taskId.slice(0, 12);
  return `agent/${shortId}-${dateSlug}`;
}
