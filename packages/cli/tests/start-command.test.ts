// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testSessionsDir = join(tmpdir(), `ak-start-command-test-${randomUUID()}`);

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    SESSIONS_DIR: testSessionsDir,
    LEGACY_SAVED_SESSIONS_FILE: join(testSessionsDir, "saved-sessions.json"),
    LEGACY_SESSION_PIDS_FILE: join(testSessionsDir, "session-pids.json"),
    PID_FILE: join(testSessionsDir, "daemon.pid"),
    STATE_DIR: testSessionsDir,
  };
});

const { writeSession, clearAllSessions } = await import("../src/session/store.js");
const { confirmDaemonShutdown, listRunningTaskSessions } = await import("../src/commands/start.js");
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
});

afterEach(() => {
  vi.restoreAllMocks();
  clearAllSessions();
  if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
  else delete (process.stdin as any).isTTY;
  if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
  else delete (process.stdout as any).isTTY;
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
