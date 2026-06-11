import type { Env } from "./types";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "agent-kanban/1.0";

export function isGithubAppConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

export interface GithubInstallationToken {
  token: string;
  expiresAt: string;
}

// Mints a repository-scoped, ~1h installation access token for the AK GitHub
// App. This is the push/PR credential cloud sandbox sessions receive — short
// lived and limited to the task's repository, unlike a server-level PAT.
export async function mintGithubInstallationToken(env: Env, owner: string, repo: string): Promise<GithubInstallationToken> {
  const jwt = await githubAppJwt(env);
  const headers = {
    authorization: `Bearer ${jwt}`,
    "user-agent": USER_AGENT,
    accept: "application/vnd.github+json",
  };

  const installationRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/installation`, { headers });
  if (!installationRes.ok) {
    throw new Error(`GitHub App is not installed on ${owner}/${repo} (HTTP ${installationRes.status})`);
  }
  const installation = (await installationRes.json()) as { id: number };

  const tokenRes = await fetch(`${GITHUB_API}/app/installations/${installation.id}/access_tokens`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      repositories: [repo],
      permissions: { contents: "write", pull_requests: "write" },
    }),
  });
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => "");
    throw new Error(`GitHub App installation token request failed (HTTP ${tokenRes.status})${detail ? `: ${detail}` : ""}`);
  }
  const token = (await tokenRes.json()) as { token: string; expires_at: string };
  return { token: token.token, expiresAt: token.expires_at };
}

async function githubAppJwt(env: Env): Promise<string> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error("GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are not configured");
  }
  const key = await crypto.subtle.importKey("pkcs8", base64Decode(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  // iat backdated 60s for clock drift, exp well under GitHub's 10-minute cap.
  const body = `${base64UrlEncodeJson({ alg: "RS256", typ: "JWT" })}.${base64UrlEncodeJson({ iss: appId, iat: now - 60, exp: now + 540 })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// GITHUB_APP_PRIVATE_KEY is the base64 of the PKCS#8 PEM (or the raw PEM).
function base64Decode(value: string): ArrayBuffer {
  const pem = value.includes("-----BEGIN") ? value : atob(value.trim());
  const der = pem.replaceAll(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replaceAll(/\s+/g, "");
  const raw = atob(der);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
