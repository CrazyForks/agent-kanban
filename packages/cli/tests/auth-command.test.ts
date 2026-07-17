// @vitest-environment node

import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateRepositoryGithubToken = vi.hoisted(() => vi.fn());
const mockGetRepository = vi.hoisted(() => vi.fn());
const mockConfigureGithubAuth = vi.hoisted(() => vi.fn());
const mockLoginLeaderAgent = vi.hoisted(() => vi.fn());
const mockDetectRuntime = vi.hoisted(() => vi.fn(() => null));
const mockFindRuntimeAncestorPid = vi.hoisted(() => vi.fn(() => null));
const mockReadWorkerAuthSession = vi.hoisted(() => vi.fn(() => null));
const mockLoadIdentity = vi.hoisted(() => vi.fn(() => null));
const mockListSessions = vi.hoisted(() => vi.fn(() => []));
const mockIsPidAlive = vi.hoisted(() => vi.fn(() => false));
const mockCreateClient = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      getRepository: mockGetRepository,
      createRepositoryGithubToken: mockCreateRepositoryGithubToken,
    }),
  ),
);
const mockAgentClientFromEnv = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../src/agent/leader.js", () => ({
  createClient: mockCreateClient,
  loginLeaderAgent: mockLoginLeaderAgent,
}));

vi.mock("../src/agent/runtime.js", () => ({
  detectRuntime: mockDetectRuntime,
  findRuntimeAncestorPid: mockFindRuntimeAncestorPid,
}));

vi.mock("../src/agent/identity.js", () => ({
  loadIdentity: mockLoadIdentity,
}));

vi.mock("../src/auth/session.js", () => ({
  clearWorkerAuthSession: vi.fn(),
  readWorkerAuthSession: mockReadWorkerAuthSession,
  writeWorkerAuthSession: vi.fn(),
}));

vi.mock("../src/client/agent.js", () => ({
  AgentClient: {
    fromEnv: mockAgentClientFromEnv,
  },
}));

vi.mock("../src/config.js", () => ({
  getCredentials: vi.fn(() => ({ apiUrl: "https://api.example.com", apiKey: "test-key" })),
  saveCredentials: vi.fn(),
}));

vi.mock("../src/session/store.js", () => ({
  listSessions: mockListSessions,
  isPidAlive: mockIsPidAlive,
}));

vi.mock("../src/commands/github.js", () => ({
  configureGithubAuth: mockConfigureGithubAuth,
}));

const { registerAuthCommand } = await import("../src/commands/auth.js");

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerAuthCommand(program);
  return program;
}

function leaderAuthGuidance(runtime: string): string {
  return [
    "No AK auth session found.",
    `For a leader agent in the current ${runtime} runtime, run:`,
    "  ak auth login --leader-agent --username <username> [--name <name>]",
  ].join("\n");
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AK_WORKER;
  delete process.env.AK_API_URL;
  delete process.env.AK_API_KEY;
  delete process.env.AK_AGENT_ID;
  delete process.env.AK_BOARD_ID;
  delete process.env.AK_MAINTAINER_ID;
  delete process.env.AK_SESSION_ID;
  delete process.env.AK_AGENT_KEY;
  delete process.env.AMA_WORKSPACE_HOME;
  delete process.env.AMA_WORKSPACE;
  mockGetRepository.mockResolvedValue({ id: "repo-1", url: "https://github.com/org/repo" });
  mockCreateRepositoryGithubToken.mockResolvedValue({
    repository_id: "repo-1",
    full_name: "org/repo",
    token: "ghs_repo_token",
    expires_at: "2026-06-25T13:00:00Z",
  });
  mockConfigureGithubAuth.mockResolvedValue("configured");
  mockLoginLeaderAgent.mockResolvedValue({
    identity: { agent_id: "agent-leader-1", name: "Codex Leader", fingerprint: "fp-1" },
    sessionId: "session-leader-1",
    reusedIdentity: false,
  });
  mockDetectRuntime.mockReturnValue(null);
  mockFindRuntimeAncestorPid.mockReturnValue(null);
  mockReadWorkerAuthSession.mockReturnValue(null);
  mockLoadIdentity.mockReturnValue(null);
  mockListSessions.mockReturnValue([]);
  mockIsPidAlive.mockReturnValue(false);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.AK_WORKER;
  delete process.env.AK_API_URL;
  delete process.env.AK_API_KEY;
  delete process.env.AK_AGENT_ID;
  delete process.env.AK_BOARD_ID;
  delete process.env.AK_MAINTAINER_ID;
  delete process.env.AK_SESSION_ID;
  delete process.env.AK_AGENT_KEY;
  delete process.env.AMA_WORKSPACE_HOME;
  delete process.env.AMA_WORKSPACE;
  consoleLogSpy.mockRestore();
});

describe("auth login command", () => {
  it("creates a leader agent identity for the current runtime", async () => {
    mockDetectRuntime.mockReturnValue("codex");

    await makeProgram().parseAsync(["auth", "login", "--leader-agent", "--username", "codex-leader", "--name", "Codex Leader"], { from: "user" });

    expect(mockLoginLeaderAgent).toHaveBeenCalledWith({ runtime: "codex", username: "codex-leader", name: "Codex Leader" });
    expect(consoleLogSpy).toHaveBeenCalledWith("Created AK leader agent identity agent-leader-1");
    expect(consoleLogSpy).toHaveBeenCalledWith("Created AK leader agent session session-leader-1");
  });
});

describe("auth whoami command", () => {
  it("rejects a local leader identity when the runtime PID is unavailable", async () => {
    mockDetectRuntime.mockReturnValue("codex");
    mockLoadIdentity.mockReturnValue({ agent_id: "agent-leader-1", name: "Codex Leader", fingerprint: "fp-1" });

    await expect(makeProgram().parseAsync(["auth", "whoami"], { from: "user" })).rejects.toThrow(leaderAuthGuidance("codex"));

    expect(mockFindRuntimeAncestorPid).toHaveBeenCalledWith("codex");
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it("rejects a local leader identity when no matching session exists", async () => {
    mockDetectRuntime.mockReturnValue("codex");
    mockFindRuntimeAncestorPid.mockReturnValue(12345);
    mockLoadIdentity.mockReturnValue({ agent_id: "agent-leader-1", name: "Codex Leader", fingerprint: "fp-1" });

    await expect(makeProgram().parseAsync(["auth", "whoami"], { from: "user" })).rejects.toThrow(leaderAuthGuidance("codex"));

    expect(mockListSessions).toHaveBeenCalledWith({ type: "leader" });
    expect(mockIsPidAlive).not.toHaveBeenCalled();
  });

  it("rejects a matching leader session when its runtime PID is dead", async () => {
    mockDetectRuntime.mockReturnValue("codex");
    mockFindRuntimeAncestorPid.mockReturnValue(12345);
    mockLoadIdentity.mockReturnValue({ agent_id: "agent-leader-1", name: "Codex Leader", fingerprint: "fp-1" });
    mockListSessions.mockReturnValue([
      {
        type: "leader",
        agentId: "agent-leader-1",
        sessionId: "session-leader-1",
        runtime: "codex",
        pid: 12345,
        apiUrl: "https://api.example.com",
        startedAt: 0,
        privateKeyJwk: {},
      },
    ]);

    await expect(makeProgram().parseAsync(["auth", "whoami"], { from: "user" })).rejects.toThrow(leaderAuthGuidance("codex"));

    expect(mockIsPidAlive).toHaveBeenCalledWith(12345);
  });

  it("shows a valid local leader session and its session ID", async () => {
    mockDetectRuntime.mockReturnValue("codex");
    mockFindRuntimeAncestorPid.mockReturnValue(12345);
    mockLoadIdentity.mockReturnValue({ agent_id: "agent-leader-1", name: "Codex Leader", fingerprint: "fp-1" });
    mockListSessions.mockReturnValue([
      {
        type: "leader",
        agentId: "agent-leader-1",
        sessionId: "session-leader-1",
        runtime: "codex",
        pid: 12345,
        apiUrl: "https://api.example.com",
        startedAt: 0,
        privateKeyJwk: {},
      },
    ]);
    mockIsPidAlive.mockReturnValue(true);

    await makeProgram().parseAsync(["auth", "whoami"], { from: "user" });

    expect(consoleLogSpy).toHaveBeenCalledWith("Type:        leader");
    expect(consoleLogSpy).toHaveBeenCalledWith("Runtime:     codex");
    expect(consoleLogSpy).toHaveBeenCalledWith("Agent ID:    agent-leader-1");
    expect(consoleLogSpy).toHaveBeenCalledWith("Session ID:  session-leader-1");
  });

  it("guides a leader runtime to leader-agent login when no session exists", async () => {
    mockDetectRuntime.mockReturnValue("codex");

    await expect(makeProgram().parseAsync(["auth", "whoami"], { from: "user" })).rejects.toThrow(leaderAuthGuidance("codex"));
  });

  it("guides a maintainer worker to auth login when no session exists", async () => {
    process.env.AK_API_KEY = "ak_maint_test";
    process.env.AK_MAINTAINER_ID = "maintainer-1";

    await expect(makeProgram().parseAsync(["auth", "whoami"], { from: "user" })).rejects.toThrow(/For a maintainer worker, run:\n {2}ak auth login/);
  });

  it("reports incomplete worker session injection without suggesting leader login", async () => {
    process.env.AK_WORKER = "1";

    await expect(makeProgram().parseAsync(["auth", "whoami"], { from: "user" })).rejects.toThrow(
      /runtime should inject AK_AGENT_ID, AK_SESSION_ID, AK_AGENT_KEY, and AK_API_URL/,
    );
  });
});

describe("auth git command", () => {
  it("prints a minted repository token", async () => {
    await makeProgram().parseAsync(["auth", "git", "repo-1", "--print-token"], { from: "user" });

    expect(mockGetRepository).toHaveBeenCalledWith("repo-1");
    expect(mockCreateRepositoryGithubToken).toHaveBeenCalledWith("repo-1");
    expect(mockConfigureGithubAuth).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith("ghs_repo_token");
  });

  it("configures GitHub auth inside an AK worker", async () => {
    process.env.AK_WORKER = "1";
    process.env.AMA_WORKSPACE_HOME = "/tmp/ak-session-home";

    await makeProgram().parseAsync(["auth", "git", "repo-1"], { from: "user" });

    expect(mockCreateRepositoryGithubToken).toHaveBeenCalledWith("repo-1");
    expect(mockConfigureGithubAuth).toHaveBeenCalledWith("ghs_repo_token", { homeDir: "/tmp/ak-session-home" });
    expect(consoleLogSpy).toHaveBeenCalledWith("Configured GitHub auth for org/repo; gh credentials configured; expires at 2026-06-25T13:00:00Z");
    expect(consoleLogSpy).toHaveBeenCalledWith("Token validity: about 1 hour. If it expires, re-run `ak auth git repo-1` to mint a fresh token.");
  });

  it("uses AMA_WORKSPACE .home for worker GitHub auth when the bridge session home is absent", async () => {
    process.env.AK_WORKER = "1";
    process.env.AMA_WORKSPACE = "/tmp/ak-workspace";

    await makeProgram().parseAsync(["auth", "git", "repo-1"], { from: "user" });

    expect(mockConfigureGithubAuth).toHaveBeenCalledWith("ghs_repo_token", { homeDir: join("/tmp/ak-workspace", ".home") });
  });

  it("refuses worker GitHub auth when the worker home is not isolated", async () => {
    process.env.AK_WORKER = "1";

    await expect(makeProgram().parseAsync(["auth", "git", "repo-1"], { from: "user" })).rejects.toThrow(
      "Refusing to modify GitHub credentials without an isolated worker HOME.",
    );

    expect(mockCreateRepositoryGithubToken).toHaveBeenCalledWith("repo-1");
    expect(mockConfigureGithubAuth).not.toHaveBeenCalled();
  });

  it("refuses to modify credentials outside an AK worker", async () => {
    await expect(makeProgram().parseAsync(["auth", "git", "repo-1"], { from: "user" })).rejects.toThrow(
      "Refusing to modify global git credentials outside an AK worker. Use --print-token.",
    );

    expect(mockCreateRepositoryGithubToken).toHaveBeenCalledWith("repo-1");
    expect(mockConfigureGithubAuth).not.toHaveBeenCalled();
  });
});
