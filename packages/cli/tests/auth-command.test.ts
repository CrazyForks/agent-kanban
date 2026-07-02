// @vitest-environment node

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateRepositoryGithubToken = vi.hoisted(() => vi.fn());
const mockGetRepository = vi.hoisted(() => vi.fn());
const mockConfigureGithubAuth = vi.hoisted(() => vi.fn());
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
  createIdentity: vi.fn(),
}));

vi.mock("../src/agent/runtime.js", () => ({
  detectRuntime: vi.fn(() => null),
}));

vi.mock("../src/auth/session.js", () => ({
  clearWorkerAuthSession: vi.fn(),
  readWorkerAuthSession: vi.fn(() => null),
  writeWorkerAuthSession: vi.fn(),
}));

vi.mock("../src/client/agent.js", () => ({
  AgentClient: {
    fromEnv: mockAgentClientFromEnv,
  },
}));

vi.mock("../src/config.js", () => ({
  saveCredentials: vi.fn(),
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

let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AK_WORKER;
  mockGetRepository.mockResolvedValue({ id: "repo-1", url: "https://github.com/org/repo" });
  mockCreateRepositoryGithubToken.mockResolvedValue({
    repository_id: "repo-1",
    full_name: "org/repo",
    token: "ghs_repo_token",
    expires_at: "2026-06-25T13:00:00Z",
  });
  mockConfigureGithubAuth.mockResolvedValue("configured");
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.AK_WORKER;
  consoleLogSpy.mockRestore();
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

    await makeProgram().parseAsync(["auth", "git", "repo-1"], { from: "user" });

    expect(mockCreateRepositoryGithubToken).toHaveBeenCalledWith("repo-1");
    expect(mockConfigureGithubAuth).toHaveBeenCalledWith("ghs_repo_token");
    expect(consoleLogSpy).toHaveBeenCalledWith("Configured GitHub auth for org/repo; gh credentials configured; expires at 2026-06-25T13:00:00Z");
  });

  it("refuses to modify credentials outside an AK worker", async () => {
    await expect(makeProgram().parseAsync(["auth", "git", "repo-1"], { from: "user" })).rejects.toThrow(
      "Refusing to modify global git credentials outside an AK worker. Use --print-token.",
    );

    expect(mockCreateRepositoryGithubToken).toHaveBeenCalledWith("repo-1");
    expect(mockConfigureGithubAuth).not.toHaveBeenCalled();
  });
});
