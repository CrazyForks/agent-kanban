// @vitest-environment node

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testSessionsDir = join(tmpdir(), `ak-start-command-test-${randomUUID()}`);
const testRunnerBin = join(testSessionsDir, "runners", "ama-runner");
const spawnMock = vi.fn(() => ({ pid: 12345, unref: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../src/amaRunner.js", () => ({
  resolveAmaRunnerBinary: vi.fn(async () => ({
    path: testRunnerBin,
    version: { name: "ama-runner", version: "0.1.0", commit: "test-commit", buildDate: "test-build" },
  })),
}));
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
const { registerRestartCommand, registerStartCommand, registerStatusCommand } = await import("../src/commands/start.js");
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
  it("starts the Machine runner, pointing it at the AMA origin and project/environment to join (runner self-authenticates)", async () => {
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
      testRunnerBin,
      [
        "--api-server",
        "https://runner-control.test",
        "--project-id",
        "project_1",
        "--environment-id",
        "env_1",
        "--max-concurrent",
        "5",
        "--allow-unsafe-process",
      ],
      expect.objectContaining({ detached: true }),
    );
    // No runner token config is written — the runner performs its own device login.
    expect(existsSync(join(testSessionsDir, "ama-runner-config.json"))).toBe(false);
    expect(spawnMock.mock.calls[0]?.[2]?.env).not.toMatchObject({ AMA_TOKEN: "runner-token" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Machine runner started"));
    const state = JSON.parse(readFileSync(join(testSessionsDir, "daemon-state.json"), "utf-8"));
    expect(state).toMatchObject({ runtime: "ama-runner", apiUrl: "https://ak.test", providers: ["codex"] });
    expect(state.runnerVersion).toMatchObject({ version: "0.1.0", commit: "test-commit" });
  });

  it("does not pass onboarding runner id before AMA registration", async () => {
    const program = new Command();
    registerStartCommand(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch("https://ama.test");

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledWith(
      testRunnerBin,
      [
        "--api-server",
        "https://ama.test",
        "--project-id",
        "project_1",
        "--environment-id",
        "env_1",
        "--max-concurrent",
        "5",
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
      testRunnerBin,
      [
        "--api-server",
        "https://runner-control.test",
        "--project-id",
        "project_1",
        "--environment-id",
        "env_1",
        "--max-concurrent",
        "5",
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

describe("status command — ama-runner with machineId", () => {
  function writeDaemonState(state: Record<string, unknown>) {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "daemon-state.json"), JSON.stringify(state));
  }

  function writePidFile(pid: number) {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "daemon.pid"), String(pid));
  }

  function writeConfig(apiUrl: string, apiKey: string) {
    mkdirSync(testSessionsDir, { recursive: true });
    const host = new URL(apiUrl).host;
    writeFileSync(
      join(testSessionsDir, "config.json"),
      JSON.stringify({ current: host, credentials: { [host]: { "api-url": apiUrl, "api-key": apiKey } } }),
    );
  }

  it("prints AMA runner online status and ready runtimes when getMachine resolves", async () => {
    const machineId = "machine-status-test";
    writePidFile(process.pid);
    writeDaemonState({
      runtime: "ama-runner",
      machineId,
      providers: ["machine-runner"],
      maxConcurrent: 5,
      pollInterval: 0,
      taskTimeout: 0,
      apiUrl: "https://ak.test",
      startedAt: new Date().toISOString(),
    });
    writeConfig("https://ak.test", "ak_test_key");

    const lastHeartbeat = new Date().toISOString();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `https://ak.test/api/machines/${machineId}`) {
        return new Response(
          JSON.stringify({
            id: machineId,
            name: "test-machine",
            status: "online",
            last_heartbeat_at: lastHeartbeat,
            runtimes: [
              { name: "claude", status: "ready", checked_at: new Date().toISOString() },
              { name: "codex", status: "ready", checked_at: new Date().toISOString() },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(["status"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("Runner:") && line.includes("online"))).toBe(true);
    expect(logged.some((line) => line.includes("Runtimes") && line.includes("claude") && line.includes("codex"))).toBe(true);
  });

  it("prints only ready runtimes, omitting non-ready ones", async () => {
    const machineId = "machine-partial-ready";
    writePidFile(process.pid);
    writeDaemonState({
      runtime: "ama-runner",
      machineId,
      providers: ["machine-runner"],
      maxConcurrent: 5,
      pollInterval: 0,
      taskTimeout: 0,
      apiUrl: "https://ak.test",
      startedAt: new Date().toISOString(),
    });
    writeConfig("https://ak.test", "ak_test_key");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      return new Response(
        JSON.stringify({
          id: machineId,
          name: "test-machine",
          status: "online",
          last_heartbeat_at: new Date().toISOString(),
          runtimes: [
            { name: "claude", status: "ready", checked_at: new Date().toISOString() },
            { name: "codex", status: "unavailable", checked_at: new Date().toISOString() },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(["status"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    const runtimesLine = logged.find((line) => line.includes("Runtimes"));
    expect(runtimesLine).toBeDefined();
    expect(runtimesLine).toContain("claude");
    expect(runtimesLine).not.toContain("codex");
  });

  it("prints error message when getMachine API call fails", async () => {
    const machineId = "machine-err";
    writePidFile(process.pid);
    writeDaemonState({
      runtime: "ama-runner",
      machineId,
      providers: ["machine-runner"],
      maxConcurrent: 5,
      pollInterval: 0,
      taskTimeout: 0,
      apiUrl: "https://ak.test",
      startedAt: new Date().toISOString(),
    });
    writeConfig("https://ak.test", "ak_test_key");

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(["status"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("Runner:") && line.includes("could not reach AK API"))).toBe(true);
  });

  it("does not print AMA runner line when state has no machineId", async () => {
    writePidFile(process.pid);
    writeDaemonState({
      runtime: "ama-runner",
      // no machineId
      providers: ["machine-runner"],
      maxConcurrent: 5,
      pollInterval: 0,
      taskTimeout: 0,
      apiUrl: "https://ak.test",
      startedAt: new Date().toISOString(),
    });
    writeConfig("https://ak.test", "ak_test_key");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(["status"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("AMA runner"))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
