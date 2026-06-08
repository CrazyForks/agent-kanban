// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testSessionsDir = join(tmpdir(), `ak-start-command-test-${randomUUID()}`);
const spawnMock = vi.fn(() => ({ pid: 12345, unref: vi.fn() }));
const assertDaemonDependenciesMock = vi.fn();

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../src/daemon/preflight.js", () => ({ assertDaemonDependencies: assertDaemonDependenciesMock }));
vi.mock("../src/providers/registry.js", () => ({ getAvailableProviders: () => [{ name: "codex" }] }));
vi.mock("../src/device.js", () => ({ generateDeviceId: () => "device-test" }));
vi.mock("../src/machineName.js", () => ({ resolveMachineName: () => "test-machine" }));

function mockMachineRunnerFetch(origin = "https://runner-control.test") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://ak.test/api/machines") {
      return new Response(
        JSON.stringify({
          id: "machine_1",
          name: "test-machine",
          runner: {
            origin,
            projectId: "project_1",
            environmentId: "env_1",
            accessToken: "runner-token",
            refreshToken: "runner-refresh-token",
            tokenType: "Bearer",
            expiresIn: 3600,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    CONFIG_DIR: testSessionsDir,
    CONFIG_FILE: join(testSessionsDir, "config.json"),
    SESSIONS_DIR: testSessionsDir,
    LEGACY_SAVED_SESSIONS_FILE: join(testSessionsDir, "saved-sessions.json"),
    LEGACY_SESSION_PIDS_FILE: join(testSessionsDir, "session-pids.json"),
    PID_FILE: join(testSessionsDir, "daemon.pid"),
    DAEMON_STATE_FILE: join(testSessionsDir, "daemon-state.json"),
    LOGS_DIR: join(testSessionsDir, "logs"),
    STATE_DIR: testSessionsDir,
  };
});

const { writeSession, clearAllSessions } = await import("../src/session/store.js");
const { confirmDaemonShutdown, listRunningTaskSessions, registerRestartCommand, registerStartCommand } = await import("../src/commands/start.js");
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function makeSession(overrides: Partial<import("../src/session/store.js").SessionFile> = {}): import("../src/session/store.js").SessionFile {
  return {
    type: "worker",
    agentId: randomUUID(),
    sessionId: randomUUID(),
    runtime: "claude" as any,
    startedAt: Date.now(),
    apiUrl: "https://example.com",
    privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "abc", d: "def" },
    status: "active",
    taskId: `task-${randomUUID()}`,
    ...overrides,
  };
}

function setTTY(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
}

beforeEach(() => {
  mkdirSync(testSessionsDir, { recursive: true });
  spawnMock.mockClear();
  assertDaemonDependenciesMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearAllSessions();
  rmSync(testSessionsDir, { recursive: true, force: true });
  if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
  else delete (process.stdin as any).isTTY;
  if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
  else delete (process.stdout as any).isTTY;
});

describe("start runtime command", () => {
  it("starts the Machine runner through AK onboarding with the original credentials flow", async () => {
    const program = new Command();
    registerStartCommand(program);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://ak.test/api/machines") {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        expect(body.runtimes).toEqual([{ name: "codex", status: "ready", checked_at: expect.any(String) }]);
        return new Response(
          JSON.stringify({
            id: "machine_1",
            name: "test-machine",
            runner: {
              origin: "https://runner-control.test",
              projectId: "project_1",
              environmentId: "env_1",
              accessToken: "runner-token",
              refreshToken: "runner-refresh-token",
              tokenType: "Bearer",
              expiresIn: 3600,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ak.test/api/machines",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer ak_test_key" }),
      }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "ama-runner",
      [
        "--config",
        join(testSessionsDir, "ama-runner-config.json"),
        "--api-server",
        "https://runner-control.test",
        "--project-id",
        "project_1",
        "--environment-id",
        "env_1",
        "--max-concurrent",
        "1",
        "--allow-unsafe-process",
      ],
      expect.objectContaining({ detached: true }),
    );
    const runnerConfig = JSON.parse(readFileSync(join(testSessionsDir, "ama-runner-config.json"), "utf-8"));
    expect(runnerConfig).toMatchObject({
      apiServer: "https://runner-control.test",
      accessToken: "runner-token",
      refreshToken: "runner-refresh-token",
      tokenType: "Bearer",
      projectId: "project_1",
      environmentId: "env_1",
    });
    expect(spawnMock.mock.calls[0]?.[2]?.env).not.toMatchObject({ AMA_TOKEN: "runner-token" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Machine runner started"));
    const state = JSON.parse(readFileSync(join(testSessionsDir, "daemon-state.json"), "utf-8"));
    expect(state).toMatchObject({ runtime: "ama-runner", apiUrl: "https://ak.test", providers: ["machine-runner"] });
  });

  it("does not pass onboarding runner id before AMA registration", async () => {
    const program = new Command();
    registerStartCommand(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch("https://ama.test");

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledWith(
      "ama-runner",
      [
        "--config",
        join(testSessionsDir, "ama-runner-config.json"),
        "--api-server",
        "https://ama.test",
        "--project-id",
        "project_1",
        "--environment-id",
        "env_1",
        "--max-concurrent",
        "1",
        "--allow-unsafe-process",
      ],
      expect.objectContaining({ detached: true }),
    );
  });
});

describe("restart runtime command", () => {
  it("restarts the Machine runner with the original AK credentials flow", async () => {
    const program = new Command();
    registerRestartCommand(program);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch();

    await program.parseAsync(["restart", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledWith(
      "ama-runner",
      [
        "--config",
        join(testSessionsDir, "ama-runner-config.json"),
        "--api-server",
        "https://runner-control.test",
        "--project-id",
        "project_1",
        "--environment-id",
        "env_1",
        "--max-concurrent",
        "1",
        "--allow-unsafe-process",
      ],
      expect.objectContaining({ detached: true }),
    );
    expect(logSpy).toHaveBeenCalledWith("○ Machine runner was not running");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Machine runner started"));
    const state = JSON.parse(readFileSync(join(testSessionsDir, "daemon-state.json"), "utf-8"));
    expect(state).toMatchObject({ runtime: "ama-runner", apiUrl: "https://ak.test" });
  });
});

describe("daemon shutdown confirmation", () => {
  it("lists only active worker sessions with task IDs as running tasks", () => {
    const active = makeSession({ taskId: "task-active" });
    writeSession(active);
    writeSession(makeSession({ status: "in_review", taskId: "task-review" }));
    writeSession(makeSession({ status: "rate_limited", taskId: "task-rate-limited" }));
    writeSession(makeSession({ status: "closed", taskId: "task-closed" }));
    writeSession(makeSession({ taskId: undefined }));
    writeSession(makeSession({ type: "leader", pid: process.pid, taskId: "task-leader" }));

    expect(listRunningTaskSessions()).toEqual([{ sessionId: active.sessionId, taskId: "task-active" }]);
  });

  it("rejects non-TTY shutdown when active tasks exist and --yes is not set", async () => {
    writeSession(makeSession({ sessionId: "session-active", taskId: "task-active" }));
    setTTY(false, false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(confirmDaemonShutdown("stop", false)).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Re-run with -y/--yes to confirm."));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("allows non-TTY shutdown when --yes is set", async () => {
    writeSession(makeSession({ taskId: "task-active" }));
    setTTY(false, false);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(confirmDaemonShutdown("restart", true)).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
