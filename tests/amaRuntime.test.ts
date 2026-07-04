// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

// hey-api's fetch client calls fetch(request) with a single Request object,
// not fetch(url, init). This helper normalises both call signatures so mocks
// can match on url, method, headers, and body regardless of which form is used.
async function parseFetchArgs(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ url: string; method: string; header: (name: string) => string | null; body: () => Promise<string> }> {
  if (input instanceof Request) {
    return {
      url: input.url,
      method: input.method,
      header: (name) => input.headers.get(name),
      body: async () => input.clone().text(),
    };
  }
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return {
    url: String(input),
    method: init?.method ?? "GET",
    header: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    body: async () => String(init?.body ?? ""),
  };
}

// hey-api defaults to parseAs:'auto' which infers JSON only when Content-Type
// is application/json. Always include it so the SDK parses the body correctly.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function amaCredential(id: string, activeVersionId?: string) {
  return { metadata: { uid: id }, spec: {}, status: { activeVersionId } };
}

function amaSession(body: any, id = "session_123") {
  return {
    metadata: { uid: id, projectId: "project_123", name: body.metadata.name, labels: {}, annotations: {} },
    spec: body.spec,
    status: { phase: "pending", reason: null },
  };
}

import { createAmaSessionSecret, createAmaTaskSession, isAmaRuntimeConfigured } from "../apps/web/server/amaRuntime";
import type { Env } from "../apps/web/server/types";

const USER_ACCESS_TOKEN = "test.jwt.token";

function linkedAccountDb(
  account: { accessToken?: string; refreshToken?: string; accessTokenExpiresAt?: string; refreshTokenExpiresAt?: string | null } | null = {},
): D1Database {
  const row =
    account === null
      ? null
      : {
          id: "acct_ama_owner",
          accessToken: account.accessToken ?? USER_ACCESS_TOKEN,
          refreshToken: account.refreshToken ?? "refresh-token",
          accessTokenExpiresAt: account.accessTokenExpiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
          refreshTokenExpiresAt: account.refreshTokenExpiresAt ?? null,
        };
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => {
              if (sql.includes("FROM account") && sql.includes("providerId = 'ama'")) return row;
              return null;
            },
            run: async () => ({ success: true }),
          };
        },
      };
    },
  } as unknown as D1Database;
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: linkedAccountDb(),
    AE: null as any,
    EMAIL: null as any,
    TUNNEL_RELAY: null as any,
    ASSETS: null as any,
    AUTH_SECRET: "test-secret",
    ALLOWED_HOSTS: "localhost",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    MAILS_ADMIN_TOKEN: "",
    CF_ACCOUNT_ID: "cf-account",
    CF_API_TOKEN: "cf-token",
    AK_API_URL: "https://ak.example.com",
    AMA_ORIGIN: "https://ama.test/",
    AMA_OIDC_ISSUER: "https://auth.test",
    AMA_OIDC_CLIENT_ID: "ak-app",
    AMA_OIDC_CLIENT_SECRET: "ak-secret",
    AMA_OIDC_SCOPES: "ama:project",
    ...overrides,
  };
}

const OWNER = "owner_123";

describe("AMA runtime adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports configured when origin and the OAuth client exist", () => {
    expect(isAmaRuntimeConfigured(env())).toBe(true);
    expect(isAmaRuntimeConfigured(env({ AMA_OIDC_CLIENT_SECRET: undefined }))).toBe(false);
    expect(isAmaRuntimeConfigured(env({ AMA_ORIGIN: undefined }))).toBe(false);
  });

  it("creates sessions through AMA SDK as the owner's linked AMA account", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = await parseFetchArgs(input, init);
      if (req.url === "https://ama.test/api/v1/sessions") {
        expect(req.method).toBe("POST");
        expect(req.header("authorization")).toBe(`Bearer ${USER_ACCESS_TOKEN}`);
        expect(req.header("x-ama-project-id")).toBe("project_123");
        const body = JSON.parse(await req.body()) as Record<string, unknown>;
        expect(body).toEqual({
          metadata: { name: "Implement metadata" },
          spec: {
            agentId: "agent_123",
            environmentId: "env_123",
            runtime: "codex",
            env: { AK_API_URL: "https://ak.example.com", AK_AGENT_ID: "agent_123" },
            envFrom: [
              {
                type: "secret",
                name: "AK_AGENT_KEY",
                secretRef: "ama://vaults/vault_123/credentials/vaultcred_123/versions/vaultver_123",
                key: "value",
              },
            ],
            volumes: [{ name: "repo", type: "git_repository", url: "https://github.com/saltbo/agent-kanban.git" }],
            volumeMounts: [{ name: "repo", mountPath: "/workspace/repos/github.com/saltbo/agent-kanban" }],
          },
          prompt: "Use AK CLI to claim and review the task.",
        });
        expect(JSON.stringify(body)).not.toContain("task_123");
        expect(JSON.stringify(body)).not.toContain("board_123");
        return jsonResponse(amaSession(body), 201);
      }
      throw new Error(`Unexpected fetch: ${req.url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const dispatch = await createAmaTaskSession(env(), OWNER, {
      projectId: "project_123",
      agentId: "agent_123",
      environmentId: "env_123",
      runtime: "codex",
      title: "Implement metadata",
      initialPrompt: "Use AK CLI to claim and review the task.",
      resourceRefs: [{ type: "github_repository", owner: "saltbo", repo: "agent-kanban" }],
      runtimeEnv: { AK_API_URL: "https://ak.example.com", AK_AGENT_ID: "agent_123" },
      runtimeSecretEnv: [{ name: "AK_AGENT_KEY", vaultId: "vault_123", credentialId: "vaultcred_123", versionId: "vaultver_123" }],
    });

    expect(dispatch).toEqual({
      projectId: "project_123",
      agentId: "agent_123",
      environmentId: "env_123",
      sessionId: "session_123",
      status: "pending",
      statusReason: null,
    });
    // Only the AMA SDK call — the linked account token comes from D1, not a fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores runtime session secrets in AMA vault credentials", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = await parseFetchArgs(input, init);
      if (req.url === "https://ama.test/api/v1/vaults/vault_123/credentials") {
        expect(req.method).toBe("POST");
        expect(req.header("authorization")).toBe(`Bearer ${USER_ACCESS_TOKEN}`);
        expect(req.header("x-ama-project-id")).toBe("project_123");
        const body = JSON.parse(await req.body()) as Record<string, any>;
        expect(body).toMatchObject({
          name: "AK_AGENT_KEY_session_123",
          type: "opaque",
          metadata: { purpose: "agent-session" },
          secret: {
            stringData: { value: '{"kty":"OKP"}' },
            referenceName: "AK_AGENT_KEY_session_123",
            metadata: { purpose: "agent-session" },
          },
        });
        return jsonResponse(amaCredential("vaultcred_123", "vaultver_123"), 201);
      }
      throw new Error(`Unexpected fetch: ${req.url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createAmaSessionSecret(env(), OWNER, {
        projectId: "project_123",
        vaultId: "vault_123",
        name: "AK_AGENT_KEY_session_123",
        secretValue: '{"kty":"OKP"}',
        metadata: { purpose: "agent-session" },
      }),
    ).resolves.toEqual({ credentialId: "vaultcred_123", activeVersionId: "vaultver_123" });
  });

  it("throws a clear error when the owner has no linked AMA account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch must not be called when there is no token");
      }),
    );
    await expect(
      createAmaSessionSecret(env({ DB: linkedAccountDb(null) }), OWNER, {
        projectId: "project_123",
        vaultId: "vault_123",
        name: "AK_AGENT_KEY_session_123",
        secretValue: "{}",
      }),
    ).rejects.toThrow(/No linked AMA account/);
  });
});
