import { getGithubAppConfig, getGithubInstallationToken } from "@/lib/agents/github/auth";

export interface WriteRepoFileInput {
  owner?: string;
  repo?: string;
  path: string;
  message: string;
  content: string;
  branch: string;
  sha?: string;
}

export interface WriteRepoFileResult {
  path: string;
  contentSha?: string;
  commitSha?: string;
  commitUrl?: string;
}

interface WriteRepoFileDeps {
  fetchImpl?: typeof fetch;
  token?: string;
}

function encodePathSegment(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function encodeFileContent(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function extractGithubError(status: number, body: unknown): string {
  if (body && typeof body === "object" && "message" in body && typeof (body as { message?: unknown }).message === "string") {
    return `github_contents_write_failed:${status}:${(body as { message: string }).message}`;
  }
  return `github_contents_write_failed:${status}`;
}

export async function writeRepoFile(input: WriteRepoFileInput, deps: WriteRepoFileDeps = {}): Promise<WriteRepoFileResult> {
  const config = getGithubAppConfig();
  const owner = trimOrUndefined(input.owner) ?? config.repoOwner;
  const repo = trimOrUndefined(input.repo) ?? config.repoName;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = deps.token ?? (await getGithubInstallationToken({ fetchImpl })).token;

  const encodedPath = encodePathSegment(input.path);
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

  let existingSha = trimOrUndefined(input.sha);
  if (!existingSha) {
    const getResponse = await fetchImpl(`${baseUrl}?ref=${encodeURIComponent(input.branch)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (getResponse.ok) {
      const getPayload = await getResponse.json() as { sha?: string };
      existingSha = trimOrUndefined(getPayload.sha);
    } else if (getResponse.status !== 404) {
      const errorBody = await getResponse.json().catch(() => null);
      throw new Error(extractGithubError(getResponse.status, errorBody));
    }
  }

  const putBody: {
    message: string;
    content: string;
    branch: string;
    sha?: string;
  } = {
    message: input.message,
    content: encodeFileContent(input.content),
    branch: input.branch,
  };
  if (existingSha) {
    putBody.sha = existingSha;
  }

  const putResponse = await fetchImpl(baseUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(putBody),
  });

  const putPayload = await putResponse.json().catch(() => null) as {
    content?: { path?: string; sha?: string };
    commit?: { sha?: string; html_url?: string };
    message?: string;
  } | null;

  if (!putResponse.ok) {
    throw new Error(extractGithubError(putResponse.status, putPayload));
  }

  return {
    path: trimOrUndefined(putPayload?.content?.path) ?? input.path,
    contentSha: trimOrUndefined(putPayload?.content?.sha),
    commitSha: trimOrUndefined(putPayload?.commit?.sha),
    commitUrl: trimOrUndefined(putPayload?.commit?.html_url),
  };
}
