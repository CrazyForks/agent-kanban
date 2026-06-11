// @vitest-environment node

/**
 * Tests for GitHub webhook handling:
 *  1. verifyGithubSignature — valid/invalid/malformed header
 *  2. POST /api/webhooks/github-app route — HMAC verification, event routing, task transitions
 *  3. handleGithubPullRequestEvent — merged/closed/skipped scenarios
 */

import { randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestAgent, seedUser, setupMiniflare } from "./helpers/db";

const WEBHOOK_SECRET = "test-webhook-secret-xyz";

let db: D1Database;
let mf: Miniflare;

// Minimal Env for direct function calls
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
    GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...overrides,
  };
}

// Build a valid X-Hub-Signature-256 header for a given body + secret
async function signWebhookBody(body: string, secret: string = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function apiRequest(method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  const { api } = await import("../apps/web/server/routes");
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http", ...headers },
    ...(body !== undefined ? { body } : {}),
  };
  return api.request(path, init, makeEnv());
}

async function apiRequestEnv(method: string, path: string, body: string | undefined, headers: Record<string, string>, env: any) {
  const { api } = await import("../apps/web/server/routes");
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http", ...headers },
    ...(body !== undefined ? { body } : {}),
  };
  return api.request(path, init, env);
}

beforeAll(async () => {
  ({ mf, db } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── 1. verifyGithubSignature unit tests ────────────────────────────────────

describe("verifyGithubSignature", () => {
  it("returns true for a valid HMAC-SHA256 signature", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    const body = JSON.stringify({ action: "closed" });
    const header = await signWebhookBody(body);
    expect(await verifyGithubSignature(WEBHOOK_SECRET, body, header)).toBe(true);
  });

  it("returns false for an invalid signature (wrong secret)", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    const body = JSON.stringify({ action: "closed" });
    const header = await signWebhookBody(body, "wrong-secret");
    expect(await verifyGithubSignature(WEBHOOK_SECRET, body, header)).toBe(false);
  });

  it("returns false for a tampered body", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    const original = JSON.stringify({ action: "closed" });
    const tampered = JSON.stringify({ action: "opened" });
    const header = await signWebhookBody(original);
    expect(await verifyGithubSignature(WEBHOOK_SECRET, tampered, header)).toBe(false);
  });

  it("returns false for a malformed header without sha256= prefix", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    const body = "{}";
    // No sha256= prefix — raw hex only (wrong format)
    expect(await verifyGithubSignature(WEBHOOK_SECRET, body, "deadbeefdeadbeef")).toBe(false);
  });

  it("returns false for a header with a non-hex value after sha256=", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    const body = "{}";
    expect(await verifyGithubSignature(WEBHOOK_SECRET, body, "sha256=ZZZZZZZZ")).toBe(false);
  });

  it("returns false for an empty signature string", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    expect(await verifyGithubSignature(WEBHOOK_SECRET, "{}", "")).toBe(false);
  });
});

// ─── 2. POST /api/webhooks/github-app — route-level integration tests ────────────

describe("POST /api/webhooks/github-app route", () => {
  it("returns 503 when GITHUB_APP_WEBHOOK_SECRET is not configured", async () => {
    const { api } = await import("../apps/web/server/routes");
    const body = "{}";
    const envNoSecret = makeEnv({ GITHUB_APP_WEBHOOK_SECRET: undefined });
    const res = await api.request(
      "/api/webhooks/github-app",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" },
        body,
      },
      envNoSecret,
    );
    expect(res.status).toBe(503);
  });

  it("returns 401 for a missing signature header", async () => {
    const body = "{}";
    const res = await apiRequest("POST", "/api/webhooks/github-app", body);
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid signature", async () => {
    const body = "{}";
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": "sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 handled:false for a non-pull_request event", async () => {
    const body = JSON.stringify({ action: "created" });
    const sig = await signWebhookBody(body);
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": sig,
      "x-github-event": "push",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.handled).toBe(false);
  });

  it("does not require an Authorization header (public route)", async () => {
    const body = JSON.stringify({ action: "closed" });
    const sig = await signWebhookBody(body);
    // No Authorization header — should succeed (not 401 for auth reasons)
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": sig,
      "x-github-event": "pull_request",
    });
    // 200 is the only acceptable status for a valid webhook (no matching tasks is OK)
    expect(res.status).toBe(200);
  });
});

// ─── 3. handleGithubPullRequestEvent logic ───────────────────────────────────

describe("handleGithubPullRequestEvent", () => {
  const OWNER = "webhook-event-test-user";

  async function seedTaskWithPrAndStatus(
    prUrl: string,
    status: string,
    annotations: Record<string, unknown> = {},
  ) {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");

    const board = await createBoard(db, OWNER, `webhook-board-${randomUUID()}`, "ops");
    const agent = await createTestAgent(db, OWNER, {
      name: `WebhookAgent-${randomUUID()}`,
      username: `webhook-agent-${randomUUID()}`,
      runtime: "claude",
    });
    const task = await createTask(db, OWNER, {
      title: `Webhook task ${randomUUID()}`,
      board_id: board.id,
      assigned_to: agent.id,
      skipRuntimeAvailability: true,
      metadata: Object.keys(annotations).length > 0 ? { annotations } : undefined,
    });
    await db.prepare("UPDATE tasks SET status = ?, pr_url = ? WHERE id = ?").bind(status, prUrl, task.id).run();
    return { task: { ...task, status, pr_url: prUrl }, agentId: agent.id };
  }

  beforeAll(async () => {
    await seedUser(db, OWNER, "webhook-event@test.com");
  });

  it("transitions in_review task to done when PR is merged", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_review");

    // Stub fetch — no AMA binding so release is a no-op
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected fetch")));

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: prUrl, merged: true },
    });

    expect(result.handled).toBe(true);
    expect(result.tasks).toContain(task.id);
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: string }>();
    expect(row!.status).toBe("done");
  });

  it("transitions in_review task to cancelled when PR is closed without merge", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_review");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected fetch")));

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: prUrl, merged: false },
    });

    expect(result.handled).toBe(true);
    expect(result.tasks).toContain(task.id);
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: string }>();
    expect(row!.status).toBe("cancelled");
  });

  it("skips in_progress task on PR merged (no state-machine path from in_progress to done)", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_progress");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected fetch")));

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: prUrl, merged: true },
    });

    // in_progress + merged → skipped
    expect(result.tasks).not.toContain(task.id);
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: string }>();
    expect(row!.status).toBe("in_progress");
  });

  it("transitions in_progress task to cancelled when PR is closed without merge", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_progress");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected fetch")));

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: prUrl, merged: false },
    });

    expect(result.tasks).toContain(task.id);
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: string }>();
    expect(row!.status).toBe("cancelled");
  });

  it("returns handled:false when action is not 'closed'", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "opened",
      pull_request: { html_url: "https://github.com/org/repo/pull/99", merged: false },
    });

    expect(result.handled).toBe(false);
    expect(result.tasks).toHaveLength(0);
  });

  it("returns handled:false when pull_request has no html_url", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { merged: true },
    });

    expect(result.handled).toBe(false);
  });

  it("clears AMA binding annotations on task completion after PR merge", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const amaSessionId = `session_wh_${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_review", {
      "ama.sessionId": amaSessionId,
      "ama.projectId": "project_123",
      "ama.dispatch.result": "accepted",
      agentSessionId: null, // no AK session — avoid needing full AMA teardown
    });

    const AMA_ENV = {
      AMA_ORIGIN: "https://ama.test",
      AMA_OAUTH_TOKEN_URL: "https://auth.test/oauth/token",
      AMA_OAUTH_CLIENT_ID: "ak-app",
      AMA_OAUTH_CLIENT_SECRET: "ak-secret",
    };

    const stops: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://auth.test/oauth/token")
          return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
        if (url.includes(`/sessions/${amaSessionId}/stop`)) {
          stops.push(url);
          return new Response(JSON.stringify({ id: amaSessionId, status: "stopped" }), { status: 200 });
        }
        // Usage summary (no akSessionId on task so collectUsage is skipped)
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const env = makeEnv(AMA_ENV);
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: prUrl, merged: true },
    });

    expect(result.tasks).toContain(task.id);
    const row = await db.prepare("SELECT metadata FROM tasks WHERE id = ?").bind(task.id).first<{ metadata: string }>();
    const meta = JSON.parse(row!.metadata ?? "{}");
    // Binding annotations cleared
    expect(meta?.annotations?.["ama.sessionId"]).toBeNull();
    expect(meta?.annotations?.["ama.dispatch.result"]).toBeNull();
    expect(stops.length).toBeGreaterThanOrEqual(1);
  });

  it("task is untouched on invalid signature via route", async () => {
    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_review");

    const body = JSON.stringify({ action: "closed", pull_request: { html_url: prUrl, merged: true } });
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": "sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "x-github-event": "pull_request",
    });

    expect(res.status).toBe(401);
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: string }>();
    expect(row!.status).toBe("in_review");
  });

  it("returns handled:true with empty tasks array when no task matches the PR URL", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: "https://github.com/org/repo/pull/99999_no_match", merged: true },
    });

    expect(result.handled).toBe(true);
    expect(result.tasks).toHaveLength(0);
  });
});
