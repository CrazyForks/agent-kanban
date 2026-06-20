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
import { hasAmaResources } from "../apps/web/server/betterAuth";
import { addCloudSandboxMachine, createTestAgent, linkAmaAccount, seedUser, setupMiniflare, signUpVerifiedUser } from "./helpers/db";

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

// hey-api's fetch client calls fetch(request) with a single Request object.
// These helpers normalise both call signatures so mocks can match on url,
// method, and body regardless of which form is used.
function reqUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}
function reqMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return input instanceof Request ? input.method : ((init as any)?.method ?? "GET");
}
async function reqBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  return input instanceof Request ? input.clone().text() : String((init as any)?.body ?? "");
}
// hey-api defaults to parseAs:'auto' which infers JSON only when Content-Type
// is application/json. Always include it so the SDK parses the body correctly.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function oauthTokenResponse() {
  return jsonResponse({ access_token: "test-token", expires_in: 3600 }, 200);
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
      const url = reqUrl(input);
      if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
      if (url === "https://ama.test/api/v1/projects" && reqMethod(input, init) === "POST") {
        projectCreates += 1;
        return jsonResponse({ id: "project_eager", name: "Workspace" }, 201);
      }
      if (url === "https://ama.test/api/v1/projects/project_eager") {
        return jsonResponse({ id: "project_eager", name: "Workspace" });
      }
      if (url === "https://ama.test/api/v1/vaults" && reqMethod(input, init) === "POST") {
        vaultCreates += 1;
        return jsonResponse({ id: "vault_eager" }, 201);
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
      if (reqUrl(input) === "https://auth.test/oauth/token") return oauthTokenResponse();
      throw new Error(`Unexpected fetch: ${reqUrl(input)}`);
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
      const url = reqUrl(input);
      if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
      if (url === "https://ama.test/api/v1/projects/project_ca") return jsonResponse({ id: "project_ca", name: "Workspace" });
      if (url === "https://ama.test/api/v1/agents" && reqMethod(input, init) === "POST") {
        agentCreateBody = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        return jsonResponse({ id: "ama_agent_ca", projectId: "project_ca", name: agentCreateBody.name, providerId: "anthropic" }, 201);
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
      const url = reqUrl(input);
      if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
      if (url === "https://ama.test/api/v1/projects/project_ca") return jsonResponse({ id: "project_ca", name: "Workspace" });
      if (url === "https://ama.test/api/v1/agents" && reqMethod(input, init) === "POST") {
        return jsonResponse({ error: "agent quota exceeded" }, 503);
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
      if (reqUrl(input) === "https://auth.test/oauth/token") return oauthTokenResponse();
      throw new Error(`Unexpected fetch: ${reqUrl(input)}`);
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
      const url = reqUrl(input);
      if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
      if (url === "https://ama.test/api/v1/projects/project_cloud_m") return jsonResponse({ id: "project_cloud_m", name: "Workspace" });
      if (url === "https://ama.test/api/v1/environments" && reqMethod(input, init) === "POST") {
        envCreateBody = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        return jsonResponse({ id: "cloud_env_m" }, 201);
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
      if (reqUrl(input) === "https://auth.test/oauth/token") return oauthTokenResponse();
      throw new Error(`Unexpected fetch: ${reqUrl(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/machines/cloud", { name: "Sandbox" }, token);
    expect(res.status).toBe(403);
  });
});

describe("disconnect guard (hasAmaResources)", () => {
  it("ignores builtin agents but counts user agents and machines", async () => {
    // Builtin/seed agents have no AMA agent, so they must not block disconnect.
    await createTestAgent(db, "guard-builtin", { name: "Soul", username: "soul", runtime: "claude" }, true);
    expect(await hasAmaResources(db, "guard-builtin")).toBe(false);

    // A user-created (non-builtin) agent is an AMA-backed resource.
    await createTestAgent(db, "guard-agent", { name: "Worker", username: "worker", runtime: "claude" }, false);
    expect(await hasAmaResources(db, "guard-agent")).toBe(true);

    // A machine (cloud sandbox here) is an AMA-backed resource.
    await seedUser(db, "guard-machine", "guard-machine@test.com");
    await addCloudSandboxMachine(db, "guard-machine", ["ama"], "env-guard");
    expect(await hasAmaResources(db, "guard-machine")).toBe(true);
  });
});

describe("delete archives the AMA resource (AMA has no hard delete)", () => {
  async function seedIntegration(userId: string, projectId: string) {
    await db
      .prepare(
        "INSERT INTO ama_owner_integrations (owner_id, ama_project_id, external_tenant_id, session_secret_vault_id, metadata) VALUES (?, ?, ?, 'vault_x', '{}')",
      )
      .bind(userId, projectId, userId)
      .run();
  }

  it("DELETE /api/agents/:id archives the AMA agent ({archived:true})", async () => {
    const env = makeEnv();
    const { userId, token } = await createSessionUser(env, "del-agent@test.com");
    await linkAmaAccount(db, userId);
    await seedIntegration(userId, "proj_del_agent");
    const agent = await createTestAgent(db, userId, { name: "Del", username: "delagent", runtime: "claude" }, false);
    const amaAgentId = `ama-agent-${agent.id}`; // set by createTestAgent

    let archiveBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
        if (url === `https://ama.test/api/v1/agents/${amaAgentId}` && reqMethod(input, init) === "PATCH") {
          archiveBody = JSON.parse(await reqBody(input, init));
          return jsonResponse({ id: amaAgentId, name: "Del", archivedAt: "2026-01-01T00:00:00.000Z" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const res = await apiRequest(env, "DELETE", `/api/agents/${agent.id}`, undefined, token);
    expect(res.status).toBe(200);
    expect(archiveBody).toEqual({ archived: true });
    // AK row is gone.
    expect(await db.prepare("SELECT 1 FROM agents WHERE id = ?").bind(agent.id).first()).toBeNull();
  });

  it("DELETE /api/machines/:id archives the AMA environment ({archived:true})", async () => {
    const env = makeEnv();
    const { userId, token } = await createSessionUser(env, "del-machine@test.com");
    await linkAmaAccount(db, userId);
    await seedIntegration(userId, "proj_del_machine");
    await addCloudSandboxMachine(db, userId, ["ama"], "env_del_machine");
    const m = await db.prepare("SELECT id FROM machines WHERE owner_id = ?").bind(userId).first<{ id: string }>();

    let archiveBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
        if (url === "https://ama.test/api/v1/environments/env_del_machine" && reqMethod(input, init) === "PATCH") {
          archiveBody = JSON.parse(await reqBody(input, init));
          return jsonResponse({ id: "env_del_machine", archivedAt: "2026-01-01T00:00:00.000Z" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const res = await apiRequest(env, "DELETE", `/api/machines/${m?.id}`, undefined, token);
    expect(res.status).toBe(200);
    expect(archiveBody).toEqual({ archived: true });
  });
});

// ─── Backfill: pre-AMA agents get their ama_agent_id on provision ───────────

describe("connect-backfills-pre-ama-agents", () => {
  // Unique project id per describe so tests don't share state across suites.
  const PROJECT_ID = "project_backfill";
  const VAULT_ID = "vault_backfill";

  // Seeds an ama_owner_integrations row so ensureAmaOwnerIntegration finds a
  // live project without needing to create one.
  async function seedIntegration(ownerId: string) {
    await db
      .prepare(
        `INSERT INTO ama_owner_integrations (owner_id, ama_project_id, external_tenant_id, session_secret_vault_id, metadata)
         VALUES (?, ?, ?, ?, '{}')
         ON CONFLICT(owner_id) DO NOTHING`,
      )
      .bind(ownerId, PROJECT_ID, ownerId, VAULT_ID)
      .run();
  }

  // Builds a fetch mock that handles the AMA URLs needed for provision+backfill.
  // agentResponses: array of per-agent responses — each element is either a
  // Response to return for that agent's POST /api/v1/agents call, or null to
  // throw an unexpected-fetch error. Calls are matched in order.
  function makeFetchMock(agentResponses: Array<Response | "error">) {
    let agentCallIndex = 0;
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
      // ensureAmaOwnerIntegration verifies the project is live via GET.
      if (url === `https://ama.test/api/v1/projects/${PROJECT_ID}`) {
        return jsonResponse({ id: PROJECT_ID, name: "Workspace" });
      }
      if (url === "https://ama.test/api/v1/agents" && reqMethod(input, init) === "POST") {
        const resp = agentResponses[agentCallIndex++];
        if (resp === "error") {
          return jsonResponse({ error: "internal server error" }, 500);
        }
        return resp;
      }
      throw new Error(`Unexpected fetch: ${url} (${reqMethod(input, init) ?? "GET"})`);
    });
  }

  it("backfills a pre-AMA agent: sets ama_agent_id and returns agents_backfilled=1", async () => {
    const env = makeEnv();
    const { userId, token } = await createSessionUser(env, "backfill-agent@test.com");
    await linkAmaAccount(db, userId);
    await seedIntegration(userId);

    // Create an agent via the helper (which sets ama_agent_id), then clear it
    // to simulate a pre-AMA agent.
    const agent = await createTestAgent(db, userId, { name: "Pre-AMA", username: "pre-ama-bf", runtime: "claude" }, false);
    await db.prepare("UPDATE agents SET ama_agent_id = NULL WHERE id = ?").bind(agent.id).run();

    const fetchMock = makeFetchMock([jsonResponse({ id: "ama_agent_x", projectId: PROJECT_ID, name: "Pre-AMA", providerId: "anthropic" }, 201)]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/ama/provision", undefined, token);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.agents_backfilled).toBe(1);

    const row = await db.prepare("SELECT ama_agent_id FROM agents WHERE id = ?").bind(agent.id).first<{ ama_agent_id: string }>();
    expect(row?.ama_agent_id).toBe("ama_agent_x");

    // Exactly one POST /api/v1/agents was made.
    const agentPostCount = fetchMock.mock.calls.filter(
      ([url, init]) => reqUrl(url) === "https://ama.test/api/v1/agents" && reqMethod(url, init) === "POST",
    ).length;
    expect(agentPostCount).toBe(1);
  });

  it("is idempotent: second provision does not create another AMA agent", async () => {
    const env = makeEnv();
    const { userId, token } = await createSessionUser(env, "backfill-idempotent@test.com");
    await linkAmaAccount(db, userId);
    await seedIntegration(userId);

    const agent = await createTestAgent(db, userId, { name: "Idempotent", username: "idempotent-bf", runtime: "claude" }, false);
    await db.prepare("UPDATE agents SET ama_agent_id = NULL WHERE id = ?").bind(agent.id).run();

    // First provision — backfills the agent.
    const firstFetch = makeFetchMock([
      jsonResponse({ id: "ama_agent_idem", projectId: PROJECT_ID, name: "Idempotent", providerId: "anthropic" }, 201),
    ]);
    vi.stubGlobal("fetch", firstFetch);
    const first = await apiRequest(env, "POST", "/api/ama/provision", undefined, token);
    expect(((await first.json()) as any).agents_backfilled).toBe(1);

    // Second provision — agent now has ama_agent_id; backfill skips it.
    // ensureAmaAgentForAkAgent will call GET /api/v1/agents/:id to verify the
    // existing AMA agent is live, so mock that too.
    const secondFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/oauth/token") return oauthTokenResponse();
      if (url === `https://ama.test/api/v1/projects/${PROJECT_ID}`) {
        return jsonResponse({ id: PROJECT_ID, name: "Workspace" });
      }
      if (url === "https://ama.test/api/v1/agents/ama_agent_idem") {
        // readAmaAgent called when ama_agent_id is already set.
        return jsonResponse({ id: "ama_agent_idem", projectId: PROJECT_ID, name: "Idempotent", providerId: "anthropic" });
      }
      if (url === "https://ama.test/api/v1/agents/ama_agent_idem" && reqMethod(input, init) === "PATCH") {
        return jsonResponse({ id: "ama_agent_idem" });
      }
      // updateAmaAgentConfig uses PATCH.
      if (url.startsWith("https://ama.test/api/v1/agents") && reqMethod(input, init) === "PATCH") {
        return jsonResponse({ id: "ama_agent_idem" });
      }
      throw new Error(`Unexpected fetch on 2nd provision: ${url} (${reqMethod(input, init) ?? "GET"})`);
    });
    vi.stubGlobal("fetch", secondFetch);

    const second = await apiRequest(env, "POST", "/api/ama/provision", undefined, token);
    expect(second.status).toBe(200);
    expect(((await second.json()) as any).agents_backfilled).toBe(0);

    // No new POST /api/v1/agents on the second call.
    const secondPostCount = secondFetch.mock.calls.filter(
      ([url, init]) => reqUrl(url) === "https://ama.test/api/v1/agents" && reqMethod(url, init) === "POST",
    ).length;
    expect(secondPostCount).toBe(0);
  });

  it("excludes builtin agents: does not backfill builtin=1 rows", async () => {
    const env = makeEnv();
    const { userId, token } = await createSessionUser(env, "backfill-builtin@test.com");
    await linkAmaAccount(db, userId);
    await seedIntegration(userId);

    // Builtin agent (createTestAgent with builtin=true) never gets ama_agent_id.
    await createTestAgent(db, userId, { name: "Builtin Soul", username: "builtin-soul-bf", runtime: "claude" }, true);

    // Fetch mock should never see a POST /api/v1/agents.
    const fetchMock = makeFetchMock([]); // no agent responses expected
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/ama/provision", undefined, token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).agents_backfilled).toBe(0);

    const agentPostCount = fetchMock.mock.calls.filter(
      ([url, init]) => reqUrl(url) === "https://ama.test/api/v1/agents" && reqMethod(url, init) === "POST",
    ).length;
    expect(agentPostCount).toBe(0);

    // Builtin row's ama_agent_id remains NULL.
    const row = await db
      .prepare("SELECT ama_agent_id FROM agents WHERE username = ? AND owner_id = ?")
      .bind("builtin-soul-bf", userId)
      .first<{ ama_agent_id: string | null }>();
    expect(row?.ama_agent_id ?? null).toBeNull();
  });

  it("excludes snapshot (non-latest) agent rows from backfill", async () => {
    const env = makeEnv();
    const { userId, token } = await createSessionUser(env, "backfill-snapshot@test.com");
    await linkAmaAccount(db, userId);
    await seedIntegration(userId);

    // Insert a non-latest (snapshot) agent row directly — no POST /api/agents
    // helper to avoid triggering the route.
    const snapshotId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO agents (id, owner_id, name, username, bio, soul, role, kind, handoff_to, runtime, model, skills, subagents, version, public_key, private_key, fingerprint, builtin, ama_agent_id, metadata, created_at, updated_at)
         VALUES (?, ?, 'Snap', 'snap-agent-bf', NULL, NULL, NULL, 'worker', NULL, 'claude', NULL, NULL, NULL, 'snapshot-v1', 'pubkey', 'privkey', 'fp', 0, NULL, '{}', ?, ?)`,
      )
      .bind(snapshotId, userId, now, now)
      .run();

    const fetchMock = makeFetchMock([]); // no POST expected
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/ama/provision", undefined, token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).agents_backfilled).toBe(0);

    const agentPostCount = fetchMock.mock.calls.filter(
      ([url, init]) => reqUrl(url) === "https://ama.test/api/v1/agents" && reqMethod(url, init) === "POST",
    ).length;
    expect(agentPostCount).toBe(0);

    // Snapshot row still has NULL ama_agent_id.
    const row = await db.prepare("SELECT ama_agent_id FROM agents WHERE id = ?").bind(snapshotId).first<{ ama_agent_id: string | null }>();
    expect(row?.ama_agent_id ?? null).toBeNull();
  });

  it("per-agent failure is non-fatal: one failing agent does not block the other", async () => {
    const env = makeEnv();
    const { userId, token } = await createSessionUser(env, "backfill-partial@test.com");
    await linkAmaAccount(db, userId);
    await seedIntegration(userId);

    // Two eligible agents, both without ama_agent_id.
    const agentA = await createTestAgent(db, userId, { name: "Agent A", username: "agent-a-bf", runtime: "claude" }, false);
    const agentB = await createTestAgent(db, userId, { name: "Agent B", username: "agent-b-bf", runtime: "claude" }, false);
    await db.prepare("UPDATE agents SET ama_agent_id = NULL WHERE id IN (?, ?)").bind(agentA.id, agentB.id).run();

    // We don't know which agent is processed first (order depends on DB), so we
    // make the mock fail on the FIRST call and succeed on the SECOND call.
    const fetchMock = makeFetchMock([
      "error",
      jsonResponse({ id: "ama_agent_success", projectId: PROJECT_ID, name: "Agent", providerId: "anthropic" }, 201),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRequest(env, "POST", "/api/ama/provision", undefined, token);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.agents_backfilled).toBe(1);

    // Exactly one of the two agents got an ama_agent_id.
    const rows = await db
      .prepare("SELECT id, ama_agent_id FROM agents WHERE id IN (?, ?) AND version = 'latest'")
      .bind(agentA.id, agentB.id)
      .all<{ id: string; ama_agent_id: string | null }>();
    const withId = rows.results.filter((r) => r.ama_agent_id !== null);
    const withoutId = rows.results.filter((r) => r.ama_agent_id === null);
    expect(withId).toHaveLength(1);
    expect(withoutId).toHaveLength(1);
    expect(withId[0].ama_agent_id).toBe("ama_agent_success");
  });
});
