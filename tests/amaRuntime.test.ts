// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAmaExternalProjectBinding,
  createAmaFederatedRunnerToken,
  createAmaSessionSecret,
  createAmaTaskSession,
  isAmaRuntimeConfigured,
} from "../apps/web/server/amaRuntime";
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
    AK_FEDERATED_RUNNER_SUBJECT_SECRET: "ak-subject-secret",
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
      if (url === "https://ama.test/api/sessions") {
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
          runtimeEnv: { AK_API_URL: "https://ak.example.com", AK_AGENT_ID: "agent_123" },
          runtimeSecretEnv: [{ name: "AK_AGENT_KEY", ref: "vaultver_123" }],
          initialPrompt: "Use AK CLI to claim and review the task.",
        });
        expect(JSON.stringify(body)).not.toContain("task_123");
        expect(JSON.stringify(body)).not.toContain("board_123");
        return new Response(
          JSON.stringify({
            id: "session_123",
            agentId: "agent_123",
            environmentId: "env_123",
            status: "pending",
            statusReason: null,
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
      runtimeSecretEnv: [{ name: "AK_AGENT_KEY", ref: "vaultver_123" }],
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
      if (url === "https://ama.test/api/vaults/vault_123/credentials") {
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

  it("creates external project bindings and exchanges AK subject tokens for runner tokens", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://auth.test/oauth/token" && String(init?.body).includes("client_credentials")) {
        return new Response(JSON.stringify({ access_token: "oauth-token" }), { status: 200 });
      }
      if (url === "https://ama.test/api/projects/project_123/external-bindings") {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>)["x-ama-project-id"]).toBe("project_123");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          issuer: "https://ak.example.com",
          externalTenantId: "owner_123",
          environmentId: "env_123",
          capabilities: ["sandbox.exec"],
        });
        return new Response(JSON.stringify({ id: "epb_123" }), { status: 201 });
      }
      if (url === "https://auth.test/oauth/token" && String(init?.body).includes("token-exchange")) {
        expect((init?.headers as Record<string, string>).authorization).toBe(`Basic ${btoa("ak-app:ak-secret")}`);
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
        expect(form.get("audience")).toBe("https://ama.test");
        expect(form.get("scope")).toBe("ama:project");
        const tokenBody = form.get("subject_token")!.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
        const payload = JSON.parse(atob(tokenBody + "=".repeat((4 - (tokenBody.length % 4)) % 4)));
        expect(payload).toMatchObject({
          iss: "https://ak.example.com",
          sub: "owner_123:runner_123",
          aud: "https://ama.test",
          external_tenant_id: "owner_123",
          ama_runner_id: "runner_123",
          ama_environment_id: "env_123",
          runner_capabilities: ["sandbox.exec"],
        });
        return new Response(JSON.stringify({ access_token: "runner-token", token_type: "Bearer", expires_in: 3600 }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await createAmaExternalProjectBinding(env(), {
      projectId: "project_123",
      issuer: "https://ak.example.com",
      externalTenantId: "owner_123",
      environmentId: "env_123",
      capabilities: ["sandbox.exec"],
    });
    await expect(
      createAmaFederatedRunnerToken(env(), {
        projectId: "project_123",
        externalTenantId: "owner_123",
        runnerId: "runner_123",
        environmentId: "env_123",
        capabilities: ["sandbox.exec"],
      }),
    ).resolves.toEqual({ accessToken: "runner-token", tokenType: "Bearer", expiresIn: 3600 });
  });
});
