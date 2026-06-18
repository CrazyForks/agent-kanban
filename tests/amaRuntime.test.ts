// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

// The per-user AMA token now comes from the linked AMA account via BetterAuth's
// getAccessToken (auto-refreshed), not a client-credentials exchange. Stub
// createAuth so amaRuntime resolves a deterministic token for the test owner.
const getAccessTokenMock = vi.fn(async ({ body }: { body: { providerId: string; userId: string } }) => {
  expect(body.providerId).toBe("ama");
  expect(body.userId).toBe("owner_123");
  return { accessToken: "user-token", accessTokenExpiresAt: new Date(Date.now() + 3600_000), scopes: [], idToken: undefined };
});
vi.mock("../apps/web/server/betterAuth", () => ({
  createAuth: () => ({ api: { getAccessToken: getAccessTokenMock } }),
}));

import { createAmaSessionSecret, createAmaTaskSession, isAmaRuntimeConfigured } from "../apps/web/server/amaRuntime";
import type { Env } from "../apps/web/server/types";

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: null as any,
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
    AMA_OAUTH_TOKEN_URL: "https://auth.test/oauth/token",
    AMA_OAUTH_CLIENT_ID: "ak-app",
    AMA_OAUTH_CLIENT_SECRET: "ak-secret",
    AMA_OAUTH_SCOPE: "ama:project",
    ...overrides,
  };
}

const OWNER = "owner_123";

describe("AMA runtime adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    getAccessTokenMock.mockClear();
  });

  it("reports configured when origin and the OAuth client exist", () => {
    expect(isAmaRuntimeConfigured(env())).toBe(true);
    expect(isAmaRuntimeConfigured(env({ AMA_OAUTH_CLIENT_SECRET: undefined }))).toBe(false);
    expect(isAmaRuntimeConfigured(env({ AMA_ORIGIN: undefined }))).toBe(false);
  });

  it("creates sessions through AMA SDK as the owner's linked AMA account", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://ama.test/api/v1/sessions") {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer user-token");
        expect((init?.headers as Record<string, string>)["x-ama-project-id"]).toBe("project_123");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          agentId: "agent_123",
          environmentId: "env_123",
          runtime: "codex",
          title: "Implement metadata",
          resourceRefs: [{ type: "github_repository", owner: "saltbo", repo: "agent-kanban" }],
          env: { AK_API_URL: "https://ak.example.com", AK_AGENT_ID: "agent_123" },
          secretEnv: [{ name: "AK_AGENT_KEY", credentialRef: { credentialId: "vaultver_123" } }],
          initialPrompt: "Use AK CLI to claim and review the task.",
        });
        expect(JSON.stringify(body)).not.toContain("task_123");
        expect(JSON.stringify(body)).not.toContain("board_123");
        return new Response(
          JSON.stringify({
            id: "session_123",
            agentId: "agent_123",
            environmentId: "env_123",
            state: "pending",
            stateReason: null,
          }),
          { status: 201 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
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
      runtimeSecretEnv: [{ name: "AK_AGENT_KEY", credentialId: "vaultver_123" }],
    });

    expect(dispatch).toEqual({
      projectId: "project_123",
      agentId: "agent_123",
      environmentId: "env_123",
      sessionId: "session_123",
      status: "pending",
      statusReason: null,
    });
    // Only the AMA SDK call — the token comes from getAccessToken, not a fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAccessTokenMock).toHaveBeenCalledWith({ body: { providerId: "ama", userId: OWNER } });
  });

  it("stores runtime session secrets in AMA vault credentials", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://ama.test/api/v1/vaults/vault_123/credentials") {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer user-token");
        expect((init?.headers as Record<string, string>)["x-ama-project-id"]).toBe("project_123");
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        expect(body).toMatchObject({
          name: "AK_AGENT_KEY_session_123",
          type: "session_env_secret",
          secret: {
            provider: "ama-managed",
            secretValue: '{"kty":"OKP"}',
            referenceName: "AK_AGENT_KEY_session_123",
          },
        });
        return new Response(JSON.stringify({ id: "vaultcred_123", activeVersionId: "vaultver_123" }), { status: 201 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
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
    getAccessTokenMock.mockResolvedValueOnce({ accessToken: "", accessTokenExpiresAt: undefined, scopes: [], idToken: undefined } as any);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch must not be called when there is no token");
      }),
    );
    await expect(
      createAmaSessionSecret(env(), OWNER, {
        projectId: "project_123",
        vaultId: "vault_123",
        name: "AK_AGENT_KEY_session_123",
        secretValue: "{}",
      }),
    ).rejects.toThrow(/No linked AMA account/);
  });
});
