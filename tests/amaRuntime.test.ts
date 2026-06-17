// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { importJWK, jwtVerify } from "jose";
import {
  createAmaFederatedRunnerToken,
  createAmaFederatedTenant,
  createAmaSessionSecret,
  createAmaTaskSession,
  isAmaRuntimeConfigured,
} from "../apps/web/server/amaRuntime";
import type { Env } from "../apps/web/server/types";

// Fixed ES256 test keypair — generated once, stable across runs.
const TEST_SIGNING_JWK = {
  kty: "EC",
  x: "YgsMptfXEIq8ALzmNQclYp40b4d2nxKbsjle3TfEyTE",
  y: "DP6x9I_82Y1J43QC9mEBiXZjOcL1J_k9S-AzZJbyAGc",
  crv: "P-256",
  d: "xa0meReZA9XMRXqAEyC_gEgnaZfrDL1CrHBXO_hCDy0",
  kid: "test-ak",
  alg: "ES256",
};

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
    AK_FEDERATED_SIGNING_KEY: JSON.stringify(TEST_SIGNING_JWK),
    ...overrides,
  };
}

describe("AMA runtime adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports configured when origin, environment, and a token source exist", () => {
    expect(isAmaRuntimeConfigured(env())).toBe(true);
    expect(isAmaRuntimeConfigured(env({ AMA_OAUTH_CLIENT_SECRET: undefined }))).toBe(false);
    expect(isAmaRuntimeConfigured(env())).toBe(true);
  });

  it("creates sessions through AMA SDK without sending AK product correlation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://auth.test/oauth/token") {
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toContain("grant_type=client_credentials");
        expect(String(init?.body)).toContain("client_id=ak-app");
        return new Response(JSON.stringify({ access_token: "oauth-token" }), { status: 200 });
      }
      if (url === "https://ama.test/api/v1/sessions") {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer oauth-token");
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

    const dispatch = await createAmaTaskSession(env(), {
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stores runtime session secrets in AMA vault credentials", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://auth.test/oauth/token") {
        return new Response(JSON.stringify({ access_token: "oauth-token" }), { status: 200 });
      }
      if (url === "https://ama.test/api/v1/vaults/vault_123/credentials") {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer oauth-token");
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
      createAmaSessionSecret(env(), {
        projectId: "project_123",
        vaultId: "vault_123",
        name: "AK_AGENT_KEY_session_123",
        secretValue: '{"kty":"OKP"}',
        metadata: { purpose: "agent-session" },
      }),
    ).resolves.toEqual({ credentialId: "vaultcred_123", activeVersionId: "vaultver_123" });
  });

  it("creates federated tenants and exchanges AK subject tokens for runner tokens", async () => {
    // The public JWK (no private component) used to verify subject tokens in the test.
    const { d: _d, ...publicJwk } = TEST_SIGNING_JWK;
    const publicKey = await importJWK(publicJwk, "ES256");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://auth.test/oauth/token" && String(init?.body).includes("client_credentials")) {
        return new Response(JSON.stringify({ access_token: "oauth-token" }), { status: 200 });
      }
      if (url === "https://ama.test/api/v1/auth/federated-tenants") {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>)["x-ama-project-id"]).toBe("project_123");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          issuer: "https://ak.example.com",
          externalTenantId: "owner_123",
          environmentId: "env_123",
          capabilities: ["session:poll", "session:claim"],
        });
        return new Response(JSON.stringify({ id: "ft_123" }), { status: 201 });
      }
      if (url === "https://auth.test/oauth/token" && String(init?.body).includes("token-exchange")) {
        expect((init?.headers as Record<string, string>).authorization).toBe(`Basic ${btoa("ak-app:ak-secret")}`);
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
        expect(form.get("audience")).toBe("https://ama.test");
        expect(form.get("scope")).toBe("runner:connect offline_access");
        // Verify the subject token is a valid ES256 JWT with the expected claims
        const subjectToken = form.get("subject_token")!;
        const { payload } = await jwtVerify(subjectToken, publicKey, { issuer: "https://ak.example.com" });
        expect(payload.sub).toBe("machine:machine_123");
        expect(payload.aud).toBe("https://ama.test");
        expect(payload.ama_project_id).toBe("project_123");
        expect(payload.ama_environment_id).toBe("env_123");
        expect(payload).not.toHaveProperty("external_tenant_id");
        return new Response(
          JSON.stringify({
            access_token: "runner-token",
            refresh_token: "runner-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await createAmaFederatedTenant(env(), {
      projectId: "project_123",
      issuer: "https://ak.example.com",
      externalTenantId: "owner_123",
      environmentId: "env_123",
    });
    await expect(
      createAmaFederatedRunnerToken(env(), {
        projectId: "project_123",
        issuer: "https://ak.example.com",
        subject: "machine:machine_123",
        environmentId: "env_123",
      }),
    ).resolves.toEqual({
      accessToken: "runner-token",
      refreshToken: "runner-refresh-token",
      tokenType: "Bearer",
      expiresIn: 3600,
    });
  });
});
