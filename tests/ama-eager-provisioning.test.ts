// @vitest-environment node

/**
 * Tests for the eager AMA provisioning refactor: AMA resources are created in
 * the AK feature actions (connect, add machine, create agent) instead of lazily
 * at dispatch.
 *
 *  1. Connect → POST /api/ama/provision creates the project + session vault.
 *  2. POST /api/agents creates the AMA agent first, then persists; rolls back on
 *     AMA failure (no partial AK row).
 *  3. POST /api/machines/cloud creates a cloud AMA environment + a cloud machine.
 *  4. Gating: create-agent, add-machine (local + cloud) require AMA connected.
 */

import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { linkAmaAccount, setupMiniflare, signUpVerifiedUser } from "./helpers/db";

const AMA_ENV = {
  AMA_ORIGIN: "https://ama.test",
  AMA_OAUTH_TOKEN_URL: "https://auth.test/oauth/token",
  AMA_OAUTH_CLIENT_ID: "ak-app",
  AMA_OAUTH_CLIENT_SECRET: "ak-secret",
  AK_API_URL: "https://ak.test",
};

let mf: Miniflare;
let db: D1Database;

function makeEnv(overrides: Record<string, unknown> = {}): any {
  return {
    DB: db,
    AE: { writeDataPoint: () => {} } as any,
    EMAIL: { send: async () => ({ messageId: "test" }) } as any,
    TUNNEL_RELAY: null as any,
    ASSETS: null as any,
    AUTH_SECRET: "test-secret-32-chars-minimum-ok!!",
    ALLOWED_HOSTS: "localhost:8788",
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    MAILS_ADMIN_TOKEN: "",
    ...AMA_ENV,
    ...overrides,
  };
}

function oauthTokenResponse() {
  return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
}

async function apiRequest(env: any, method: string, path: string, body: unknown, token?: string) {
  const { api } = await import("../apps/web/server/routes");
  const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== "GET") init.body = JSON.stringify(body);
  return api.request(path, init, env);
}

// Creates a verified user with a session token, returning the owner id + token.
async function createSessionUser(env: any, email: string): Promise<{ token: string; userId: string }> {
  const { createAuth } = await import("../apps/web/server/betterAuth");
  const auth = createAuth(env);
  const result = await signUpVerifiedUser(db, auth, { name: "Eager User", email, password: "test-password-123" });
  return { token: result.token, userId: result.user.id };
}

beforeAll(async () => {
  ({ mf, db } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connect-provisions-project", () => {
  it("POST /api/ama/provision creates the project + session vault and is idempotent", async () => {
    const env = makeEnv();
    const { userId, token } = await createSessionUser(env, "provision@test.com");
    await linkAmaAccount(db, userId);

    let projectCreates = 0;
    let vaultCreates = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
      if (url === "https://ama.test/api/v1/projects" && (init as any)?.method === "POST") {
        projectCreates += 1;
        return new Response(JSON.stringify({ id: "project_eager", name: "Workspace" }), { status: 201 });
      }
      if (url === "https://ama.test/api/v1/projects/project_eager") {
        return new Response(JSON.stringify({ id: "project_eager", name: "Workspace" }), { status: 200 });
      }
      if (url === "https://ama.test/api/v1/vaults" && (init as any)?.method === "POST") {
        vaultCreates += 1;
        return new Response(JSON.stringify({ id: "vault_eager" }), { status: 201 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/ama/provision", undefined, token);
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ ok: true, project_id: "project_eager" });

    const row = await db
      .prepare("SELECT ama_project_id, session_secret_vault_id FROM ama_owner_integrations WHERE owner_id = ?")
      .bind(userId)
      .first<{ ama_project_id: string; session_secret_vault_id: string }>();
    expect(row).toMatchObject({ ama_project_id: "project_eager", session_secret_vault_id: "vault_eager" });

    // Second call reuses the live project/vault — no new creates.
    const again = await apiRequest(env, "POST", "/api/ama/provision", undefined, token);
    expect(again.status).toBe(200);
    expect(projectCreates).toBe(1);
    expect(vaultCreates).toBe(1);
  });

  it("returns 403 when the user has not linked AMA", async () => {
    const env = makeEnv();
    const { token } = await createSessionUser(env, "provision-unlinked@test.com");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://auth.test/oauth/token") return oauthTokenResponse();
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/ama/provision", undefined, token);
    expect(res.status).toBe(403);
  });
});

describe("create-agent-creates-ama-agent-first", () => {
  async function seedIntegration(ownerId: string) {
    await db
      .prepare(
        `INSERT INTO ama_owner_integrations (owner_id, ama_project_id, external_tenant_id, session_secret_vault_id, metadata)
         VALUES (?, 'project_ca', ?, 'vault_ca', '{}')
         ON CONFLICT(owner_id) DO NOTHING`,
      )
      .bind(ownerId, ownerId)
      .run();
  }

  it("creates the AMA agent first, then persists the AK agent with ama_agent_id", async () => {
    const env = makeEnv();
    const { userId, token } = await createSessionUser(env, "create-agent@test.com");
    await linkAmaAccount(db, userId);
    await seedIntegration(userId);

    let agentCreateBody: Record<string, any> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
      if (url === "https://ama.test/api/v1/projects/project_ca")
        return new Response(JSON.stringify({ id: "project_ca", name: "Workspace" }), { status: 200 });
      if (url === "https://ama.test/api/v1/agents" && (init as any)?.method === "POST") {
        agentCreateBody = JSON.parse(String(init?.body)) as Record<string, any>;
        return new Response(JSON.stringify({ id: "ama_agent_ca", projectId: "project_ca", name: agentCreateBody.name, providerId: "anthropic" }), {
          status: 201,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/agents", { name: "Eager Agent", username: "eager-agent", runtime: "claude" }, token);
    expect(res.status).toBe(201);
    expect(agentCreateBody).toBeTruthy();

    const created = (await res.json()) as any;
    const row = await db.prepare("SELECT ama_agent_id FROM agents WHERE id = ?").bind(created.id).first<{ ama_agent_id: string }>();
    expect(row?.ama_agent_id).toBe("ama_agent_ca");
  });

  it("rolls back: persists no AK agent when the AMA agent creation fails", async () => {
    const env = makeEnv();
    const { userId, token } = await createSessionUser(env, "create-agent-rollback@test.com");
    await linkAmaAccount(db, userId);
    await seedIntegration(userId);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
      if (url === "https://ama.test/api/v1/projects/project_ca")
        return new Response(JSON.stringify({ id: "project_ca", name: "Workspace" }), { status: 200 });
      if (url === "https://ama.test/api/v1/agents" && (init as any)?.method === "POST") {
        return new Response(JSON.stringify({ error: "agent quota exceeded" }), { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/agents", { name: "Rollback Agent", username: "rollback-agent", runtime: "claude" }, token);
    expect(res.status).toBeGreaterThanOrEqual(500);

    const row = await db.prepare("SELECT id FROM agents WHERE username = ? AND owner_id = ?").bind("rollback-agent", userId).first();
    expect(row).toBeNull();
  });

  it("blocks create-agent when AMA is not connected", async () => {
    const env = makeEnv();
    const { token } = await createSessionUser(env, "create-agent-gate@test.com");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://auth.test/oauth/token") return oauthTokenResponse();
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/agents", { name: "Gated Agent", username: "gated-agent", runtime: "claude" }, token);
    expect(res.status).toBe(403);
  });

  it("standalone AK (AMA not configured) creates agents without AMA", async () => {
    const env = makeEnv({
      AMA_ORIGIN: undefined,
      AMA_OAUTH_TOKEN_URL: undefined,
      AMA_OAUTH_CLIENT_ID: undefined,
      AMA_OAUTH_CLIENT_SECRET: undefined,
    });
    const { token } = await createSessionUser(env, "standalone-agent@test.com");

    const res = await apiRequest(env, "POST", "/api/agents", { name: "Standalone Agent", username: "standalone-agent", runtime: "claude" }, token);
    expect(res.status).toBe(201);
    const created = (await res.json()) as any;
    const row = await db.prepare("SELECT ama_agent_id FROM agents WHERE id = ?").bind(created.id).first<{ ama_agent_id: string | null }>();
    expect(row?.ama_agent_id ?? null).toBeNull();
  });
});

describe("add-cloud-sandbox-creates-cloud-env", () => {
  it("POST /api/machines/cloud creates a cloud AMA environment + a cloud machine", async () => {
    const env = makeEnv();
    const { userId, token } = await createSessionUser(env, "cloud-machine@test.com");
    await linkAmaAccount(db, userId);
    await db
      .prepare(
        `INSERT INTO ama_owner_integrations (owner_id, ama_project_id, external_tenant_id, session_secret_vault_id, metadata)
         VALUES (?, 'project_cloud_m', ?, 'vault_cloud_m', '{}')`,
      )
      .bind(userId, userId)
      .run();

    let envCreateBody: Record<string, any> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
      if (url === "https://ama.test/api/v1/projects/project_cloud_m")
        return new Response(JSON.stringify({ id: "project_cloud_m", name: "Workspace" }), { status: 200 });
      if (url === "https://ama.test/api/v1/environments" && (init as any)?.method === "POST") {
        envCreateBody = JSON.parse(String(init?.body)) as Record<string, any>;
        return new Response(JSON.stringify({ id: "cloud_env_m" }), { status: 201 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/machines/cloud", { name: "My sandbox" }, token);
    expect(res.status).toBe(201);
    const machine = (await res.json()) as any;
    expect(machine.hosting).toBe("cloud");
    expect(envCreateBody?.hostingMode).toBe("cloud");
    // The public machine never exposes the AMA environment id.
    expect(machine).not.toHaveProperty("ama_environment_id");

    const row = await db
      .prepare("SELECT hosting, ama_environment_id FROM machines WHERE id = ?")
      .bind(machine.id)
      .first<{ hosting: string; ama_environment_id: string }>();
    expect(row).toMatchObject({ hosting: "cloud", ama_environment_id: "cloud_env_m" });
  });

  it("blocks cloud sandbox creation when AMA is not connected", async () => {
    const env = makeEnv();
    const { token } = await createSessionUser(env, "cloud-machine-gate@test.com");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://auth.test/oauth/token") return oauthTokenResponse();
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/machines/cloud", { name: "Sandbox" }, token);
    expect(res.status).toBe(403);
  });
});
