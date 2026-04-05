import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { getGithubInstallationToken } from "@/lib/agents/github/auth";

describe("github auth helper", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    vi.restoreAllMocks();
  });

  it("builds installation token request with app jwt", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });

    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_INSTALLATION_ID = "98765";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    process.env.GITHUB_REPO_OWNER = "owner";
    process.env.GITHUB_REPO_NAME = "repo";

    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ token: "inst_token", expires_at: "2026-04-05T11:00:00Z" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    const token = await getGithubInstallationToken({ fetchImpl, nowSeconds: () => 1_750_000_000 });

    expect(token).toEqual({
      token: "inst_token",
      expiresAt: "2026-04-05T11:00:00Z",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/98765/access_tokens");
    expect(init.method).toBe("POST");
    expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^Bearer\s+.+/);
  });
});
