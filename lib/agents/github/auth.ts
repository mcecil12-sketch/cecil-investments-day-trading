import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

export interface GithubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string;
  repoOwner: string;
  repoName: string;
}

interface GithubAuthDeps {
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

export interface GithubInstallationToken {
  token: string;
  expiresAt?: string;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing_env_${name.toLowerCase()}`);
  }
  return value;
}

function normalizePrivateKey(rawKey: string): string {
  let normalized = rawKey.trim();

  const hasDoubleQuotes = normalized.startsWith('"') && normalized.endsWith('"');
  const hasSingleQuotes = normalized.startsWith("'") && normalized.endsWith("'");
  if (hasDoubleQuotes || hasSingleQuotes) {
    normalized = normalized.slice(1, -1).trim();
  }

  normalized = normalized
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n");

  return normalized;
}

function toPrivateKeyObject(privateKey: string): KeyObject {
  try {
    return createPrivateKey({
      key: normalizePrivateKey(privateKey),
      format: "pem",
    });
  } catch {
    throw new Error("invalid_github_app_private_key");
  }
}

export function getGithubAppConfig(): GithubAppConfig {
  return {
    appId: readRequiredEnv("GITHUB_APP_ID"),
    installationId: readRequiredEnv("GITHUB_INSTALLATION_ID"),
    privateKey: normalizePrivateKey(readRequiredEnv("GITHUB_APP_PRIVATE_KEY")),
    repoOwner: readRequiredEnv("GITHUB_REPO_OWNER"),
    repoName: readRequiredEnv("GITHUB_REPO_NAME"),
  };
}

export function buildGithubAppJwt(config: Pick<GithubAppConfig, "appId" | "privateKey">, nowSeconds: number): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: config.appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const keyObject = toPrivateKeyObject(config.privateKey);

  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(keyObject).toString("base64url");

  return `${unsignedToken}.${signature}`;
}

export async function getGithubInstallationToken(deps: GithubAuthDeps = {}): Promise<GithubInstallationToken> {
  const config = getGithubAppConfig();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowSeconds = Math.floor((deps.nowSeconds ?? (() => Date.now() / 1000))());
  const jwt = buildGithubAppJwt({ appId: config.appId, privateKey: config.privateKey }, nowSeconds);

  const response = await fetchImpl(
    `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`github_installation_token_failed:${response.status}:${detail || "unknown"}`);
  }

  const payload = await response.json() as { token?: string; expires_at?: string };
  if (!payload.token) {
    throw new Error("github_installation_token_missing");
  }

  return {
    token: payload.token,
    expiresAt: payload.expires_at,
  };
}
