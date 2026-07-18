// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestAgent, seedUser, setupMiniflare } from "./helpers/db";

const { dispatchTaskToAmaMock, releaseTaskRuntimeBindingMock } = vi.hoisted(() => ({
  dispatchTaskToAmaMock: vi.fn(),
  releaseTaskRuntimeBindingMock: vi.fn(),
}));

vi.mock("../apps/web/server/taskDispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../apps/web/server/taskDispatch")>();
  return {
    ...actual,
    dispatchTaskToAma: dispatchTaskToAmaMock,
    releaseTaskRuntimeBinding: releaseTaskRuntimeBindingMock,
  };
});

let db: D1Database;
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];

function env(): any {
  return {
    DB: db,
    AE: { writeDataPoint: () => {} },
    EMAIL: { send: async () => ({ messageId: "test" }) },
    AUTH_SECRET: "test-secret-32-chars-minimum-ok!!",
    ALLOWED_HOSTS: "localhost:8788",
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    MAILS_ADMIN_TOKEN: "",
    AMA_ORIGIN: "https://ama.test",
    AMA_OIDC_ISSUER: "https://auth.test",
    AMA_OIDC_CLIENT_ID: "ak-app",
    AMA_OIDC_CLIENT_SECRET: "ak-secret",
    AK_API_URL: "https://ak.test",
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

async function configureOwner(ownerId: string, environmentId: string) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ama_owner_integrations (owner_id, ama_project_id, external_tenant_id, session_secret_vault_id, metadata)
       VALUES (?, 'project-router', ?, 'vault-router', '{}')`,
    )
    .bind(ownerId, ownerId)
    .run();
  await db
    .prepare(
      `INSERT INTO machines (id, owner_id, device_id, name, os, version, runtimes, status, last_heartbeat_at, created_at, ama_environment_id)
       VALUES (?, ?, ?, 'router-machine', 'test', '1.0.0', ?, 'online', ?, ?, ?)`,
    )
    .bind(
      `machine-${randomUUID()}`,
      ownerId,
      `device-${randomUUID()}`,
      JSON.stringify([{ name: "claude", status: "ready", checked_at: now }]),
      now,
      now,
      environmentId,
    )
    .run();
}

function runnerFetch(environmentId: string, getHealthy: () => boolean) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `https://ama.test/api/v1/runners?environmentId=${environmentId}&limit=100`) {
      return json({
        data: getHealthy()
          ? [
              {
                id: "runner-router",
                environmentId,
                state: "active",
                runtimes: [
                  {
                    runtime: "claude-code",
                    models: ["claude-sonnet-4-6"],
                    state: "limited",
                    detail: "Daily quota exhausted",
                  },
                ],
                currentLoad: 5,
                maxConcurrent: 5,
                lastHeartbeatAt: new Date().toISOString(),
              },
            ]
          : [],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

beforeAll(async () => {
  ({ db, mf } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

afterEach(() => {
  dispatchTaskToAmaMock.mockReset();
  releaseTaskRuntimeBindingMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runtime source primitives", () => {
  it("uses a 60 second freshness boundary for AMA and legacy heartbeats", async () => {
    const { amaRunnerHeartbeatFresh } = await import("../apps/web/server/runtimeRouter");
    const { legacyMachineHeartbeatFresh } = await import("../apps/web/server/legacyRuntime");
    const now = Date.parse("2026-07-17T12:00:00.000Z");
    const runner = { lastHeartbeatAt: new Date(now - 60_000).toISOString() } as any;
    const machine = { status: "online", last_heartbeat_at: new Date(now - 60_000).toISOString() } as any;

    expect(amaRunnerHeartbeatFresh(runner, now)).toBe(true);
    expect(legacyMachineHeartbeatFresh(machine, now)).toBe(true);
    runner.lastHeartbeatAt = new Date(now - 60_001).toISOString();
    machine.last_heartbeat_at = new Date(now - 60_001).toISOString();
    expect(amaRunnerHeartbeatFresh(runner, now)).toBe(false);
    expect(legacyMachineHeartbeatFresh(machine, now)).toBe(false);
  });

  it("treats active limited and full AMA runners as owners, then selects AMA first", async () => {
    const { amaRunnerOwnsRuntime, selectRuntimeSource } = await import("../apps/web/server/runtimeRouter");
    const runner = {
      status: "active",
      lastHeartbeatAt: new Date().toISOString(),
      runtimes: [
        {
          runtime: "claude-code",
          models: ["claude-sonnet-4-6", "vendor:model:v2"],
          state: "limited",
          detail: "Daily quota exhausted",
        },
      ],
      currentLoad: 3,
      maxConcurrent: 3,
    } as any;

    expect(amaRunnerOwnsRuntime(runner, "claude-code")).toBe(true);
    expect(amaRunnerOwnsRuntime(runner, "claude-code", "claude-sonnet-4-6")).toBe(true);
    expect(amaRunnerOwnsRuntime(runner, "claude-code", "vendor:model:v2")).toBe(true);
    expect(amaRunnerOwnsRuntime(runner, "claude-code", "claude-opus-4-6")).toBe(false);
    expect(selectRuntimeSource({ ama: true, legacy: true })).toBe("ama");
  });

  it("does not require runner model declarations for the AMA cloud runtime", async () => {
    const { amaRunnerOwnsRuntime } = await import("../apps/web/server/runtimeRouter");
    const runner = {
      status: "active",
      lastHeartbeatAt: new Date().toISOString(),
      runtimes: [{ runtime: "ama", models: [], state: "ready" }],
    } as any;

    expect(amaRunnerOwnsRuntime(runner, "ama", "anthropic/claude-haiku-4-5")).toBe(true);
  });

  it("persists and infers the runtime source annotation", async () => {
    const { metadataWithRuntimeSource, taskRuntimeSource } = await import("../apps/web/server/runtimeBinding");
    const metadata = metadataWithRuntimeSource({ annotations: { keep: "yes" } }, "legacy");

    expect(metadata).toEqual({ annotations: { keep: "yes", "runtime.source": "legacy" } });
    expect(taskRuntimeSource({ metadata } as any)).toBe("legacy");
    expect(taskRuntimeSource({ metadata: { annotations: { "ama.sessionId": "session-1" } } } as any)).toBe("ama");
  });
});

describe("routePendingTasks", () => {
  it("selects AMA first, preserves a healthy legacy source, and switches only after its source becomes unavailable", async () => {
    const ownerId = `router-owner-${randomUUID()}`;
    const environmentId = `env-${randomUUID()}`;
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    await configureOwner(ownerId, environmentId);
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask, getTask } = await import("../apps/web/server/taskRepo");
    const { routePendingTasks } = await import("../apps/web/server/runtimeCoordinator");
    const { taskRuntimeSource } = await import("../apps/web/server/runtimeBinding");
    const board = await createBoard(db, ownerId, `router-${randomUUID()}`, "ops");
    const agent = await createTestAgent(db, ownerId, { username: `router-${randomUUID()}`, runtime: "claude" });
    const unrouted = await createTask(db, ownerId, { title: "unrouted", board_id: board.id, assigned_to: agent.id, skipRuntimeAvailability: true });
    const stickyLegacy = await createTask(db, ownerId, {
      title: "sticky legacy",
      board_id: board.id,
      assigned_to: agent.id,
      metadata: { annotations: { "runtime.source": "legacy" } },
      skipRuntimeAvailability: true,
    });
    const preboundAma = await createTask(db, ownerId, {
      title: "prebound ama",
      board_id: board.id,
      assigned_to: agent.id,
      metadata: { annotations: { "ama.sessionId": "existing-session" } },
      skipRuntimeAvailability: true,
    });
    const blocker = await createTask(db, ownerId, { title: "routing blocker", board_id: board.id });
    const blockedUnrouted = await createTask(db, ownerId, {
      title: "blocked but routable",
      board_id: board.id,
      assigned_to: agent.id,
      depends_on: [blocker.id],
      skipRuntimeAvailability: true,
    });
    const inProgressLegacy = await createTask(db, ownerId, {
      title: "claim won routing race",
      board_id: board.id,
      assigned_to: agent.id,
      metadata: { annotations: { "runtime.source": "legacy" } },
      skipRuntimeAvailability: true,
    });
    await db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(inProgressLegacy.id).run();
    let healthyAma = true;
    vi.stubGlobal(
      "fetch",
      runnerFetch(environmentId, () => healthyAma),
    );

    try {
      await routePendingTasks(db, env());
      expect(taskRuntimeSource((await getTask(db, unrouted.id, ownerId))!)).toBe("ama");
      expect(taskRuntimeSource((await getTask(db, stickyLegacy.id, ownerId))!)).toBe("legacy");
      const persistedPrebound = await db.prepare("SELECT metadata FROM tasks WHERE id = ?").bind(preboundAma.id).first<{ metadata: string }>();
      expect(JSON.parse(persistedPrebound!.metadata).annotations["runtime.source"]).toBe("ama");
      expect(taskRuntimeSource((await getTask(db, blockedUnrouted.id, ownerId))!)).toBe("ama");

      await db
        .prepare("UPDATE machines SET last_heartbeat_at = ? WHERE owner_id = ?")
        .bind(new Date(Date.now() - 60_001).toISOString(), ownerId)
        .run();
      await routePendingTasks(db, env());
      expect(taskRuntimeSource((await getTask(db, stickyLegacy.id, ownerId))!)).toBe("ama");
      expect(taskRuntimeSource((await getTask(db, inProgressLegacy.id, ownerId))!)).toBe("legacy");

      await db.prepare("UPDATE machines SET last_heartbeat_at = ? WHERE owner_id = ?").bind(new Date().toISOString(), ownerId).run();
      healthyAma = false;
      await routePendingTasks(db, env());
      expect(taskRuntimeSource((await getTask(db, unrouted.id, ownerId))!)).toBe("legacy");
      const stickyPrebound = await db.prepare("SELECT metadata FROM tasks WHERE id = ?").bind(preboundAma.id).first<{ metadata: string }>();
      expect(JSON.parse(stickyPrebound!.metadata).annotations["runtime.source"]).toBe("ama");
    } finally {
      await db.prepare("UPDATE tasks SET status = 'done' WHERE board_id = ?").bind(board.id).run();
    }
  });

  it("leaves legacy-owned tasks out of the AMA dispatch sweep", async () => {
    const ownerId = `legacy-sweep-${randomUUID()}`;
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { dispatchPendingAmaTasks } = await import("../apps/web/server/taskDispatch");
    const board = await createBoard(db, ownerId, `legacy-sweep-${randomUUID()}`, "ops");
    const agent = await createTestAgent(db, ownerId, { username: `legacy-sweep-${randomUUID()}`, runtime: "claude" });
    await createTask(db, ownerId, {
      title: "legacy only",
      board_id: board.id,
      assigned_to: agent.id,
      metadata: { annotations: { "runtime.source": "legacy" } },
      skipRuntimeAvailability: true,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await dispatchPendingAmaTasks(db, env());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("dispatchAssignedTask", () => {
  it("keeps legacy-owned tasks local and delegates AMA-owned tasks through the unified coordinator", async () => {
    const { dispatchAssignedTask } = await import("../apps/web/server/runtimeCoordinator");
    const legacy = {
      id: "legacy-task",
      metadata: { annotations: { "runtime.source": "legacy" } },
    } as any;
    const ama = {
      id: "ama-task",
      metadata: { annotations: { "runtime.source": "ama" } },
    } as any;
    const dispatchedAma = {
      ...ama,
      metadata: { annotations: { ...ama.metadata.annotations, "ama.dispatch.result": "accepted" } },
    };
    const options = { apiOrigin: "https://ak.test", takeover: true, recordFailure: false };
    dispatchTaskToAmaMock.mockResolvedValue(dispatchedAma);

    await expect(dispatchAssignedTask(db, env(), "owner", legacy, options)).resolves.toBe(legacy);
    expect(dispatchTaskToAmaMock).not.toHaveBeenCalled();

    await expect(dispatchAssignedTask(db, env(), "owner", ama, options)).resolves.toBe(dispatchedAma);
    expect(dispatchTaskToAmaMock).toHaveBeenCalledOnce();
    const [calledDb, , calledOwner, calledTask, calledOptions] = dispatchTaskToAmaMock.mock.calls[0]!;
    expect(calledDb).toBe(db);
    expect(calledOwner).toBe("owner");
    expect(calledTask).toBe(ama);
    expect(calledOptions).toBe(options);
  });
});

describe("releaseAssignedTaskRuntime", () => {
  it("keeps explicit legacy tasks local but delegates AMA and historical bindings", async () => {
    const { releaseAssignedTaskRuntime } = await import("../apps/web/server/runtimeCoordinator");
    const legacy = {
      id: "legacy-release-task",
      metadata: { annotations: { "runtime.source": "legacy" } },
    } as any;
    const unknown = {
      id: "historical-release-task",
      metadata: { annotations: { agentSessionId: "historical-session" } },
    } as any;
    const ama = {
      id: "ama-release-task",
      metadata: { annotations: { "runtime.source": "ama" } },
    } as any;
    releaseTaskRuntimeBindingMock.mockImplementation(async (_db, _env, _owner, task) => ({ ...task, assigned_to: null }));

    await expect(releaseAssignedTaskRuntime(db, env(), "owner", legacy, "policy")).resolves.toBe(legacy);
    expect(releaseTaskRuntimeBindingMock).not.toHaveBeenCalled();

    await expect(releaseAssignedTaskRuntime(db, env(), "owner", unknown, "runtime_error")).resolves.toEqual({ ...unknown, assigned_to: null });
    await expect(releaseAssignedTaskRuntime(db, env(), "owner", ama, "timeout")).resolves.toEqual({ ...ama, assigned_to: null });
    expect(releaseTaskRuntimeBindingMock).toHaveBeenCalledTimes(2);
    const [calledDb, , calledOwner, calledTask, calledReason] = releaseTaskRuntimeBindingMock.mock.calls[0]!;
    expect(calledDb).toBe(db);
    expect(calledOwner).toBe("owner");
    expect(calledTask).toBe(unknown);
    expect(calledReason).toBe("runtime_error");
    const [, , , calledAmaTask, calledAmaReason] = releaseTaskRuntimeBindingMock.mock.calls[1]!;
    expect(calledAmaTask).toBe(ama);
    expect(calledAmaReason).toBe("timeout");
  });
});
