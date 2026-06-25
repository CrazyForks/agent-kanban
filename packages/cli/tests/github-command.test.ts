// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHomedir = vi.hoisted(() => vi.fn(() => "/tmp"));
const mockSpawn = vi.hoisted(() => vi.fn());
const mockCreateRepositoryGithubToken = vi.fn();
const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    createRepositoryGithubToken: mockCreateRepositoryGithubToken,
  }),
);

vi.mock("../src/agent/leader.js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: mockHomedir };
});

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  return {
    spawn: mockSpawn.mockImplementation(() => {
      const child: any = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }),
  };
});

const { configureGithubAuth, registerGithubCommand } = await import("../src/commands/github.js");

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerGithubCommand(program);
  return program;
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AK_WORKER;
  mockHomedir.mockReturnValue(tmpdir());
  mockSpawn.mockImplementation(() => {
    const child: any = new EventTarget();
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    child.stderr = { on: vi.fn() };
    child.stdin = { end: vi.fn() };
    child.on = vi.fn((event: string, callback: (value?: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      if (event === "close") queueMicrotask(() => callback(0));
      return child;
    });
    return child;
  });
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as any);
});

afterEach(() => {
  delete process.env.AK_WORKER;
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  processExitSpy.mockRestore();
});

describe("configureGithubAuth", () => {
  it("writes git credentials, replaces existing github credentials, and configures gh", async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-gh-auth-"));
    try {
      await writeFile(join(home, ".git-credentials"), "https://old-token@github.com\nhttps://user:token@example.com\n");
      const calls: Array<{ file: string; args: string[]; input?: string }> = [];
      const status = await configureGithubAuth("ghs_new_token", {
        homeDir: home,
        run: async (file, args, options) => {
          calls.push({ file, args, input: options?.input });
        },
      });

      expect(status).toBe("configured");
      expect(await readFile(join(home, ".git-credentials"), "utf-8")).toBe(
        "https://user:token@example.com\nhttps://x-access-token:ghs_new_token@github.com\n",
      );
      expect(calls).toEqual([
        { file: "git", args: ["config", "--global", "credential.helper", "store"], input: undefined },
        { file: "gh", args: ["--version"], input: undefined },
        { file: "gh", args: ["auth", "login", "--hostname", "github.com", "--with-token"], input: "ghs_new_token" },
        { file: "gh", args: ["auth", "setup-git", "--hostname", "github.com"], input: undefined },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("still configures git credentials when gh is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-gh-missing-"));
    try {
      const status = await configureGithubAuth("ghs_git_only", {
        homeDir: home,
        run: async (file) => {
          if (file === "gh") throw new Error("not found");
        },
      });

      expect(status).toBe("missing");
      expect(await readFile(join(home, ".git-credentials"), "utf-8")).toBe("https://x-access-token:ghs_git_only@github.com\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("github auth command", () => {
  it("mints a repo token and configures git and gh by default", async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-gh-command-"));
    try {
      process.env.AK_WORKER = "1";
      mockHomedir.mockReturnValue(home);
      mockCreateRepositoryGithubToken.mockResolvedValue({
        repository_id: "repo-1",
        full_name: "org/repo",
        token: "ghs_configure_me",
        expires_at: "2026-06-25T13:00:00Z",
      });

      await makeProgram().parseAsync(["github", "auth", "repo-1"], { from: "user" });

      expect(mockCreateRepositoryGithubToken).toHaveBeenCalledWith("repo-1");
      expect(await readFile(join(home, ".git-credentials"), "utf-8")).toBe("https://x-access-token:ghs_configure_me@github.com\n");
      expect(mockSpawn).toHaveBeenCalledWith("git", ["config", "--global", "credential.helper", "store"], expect.any(Object));
      expect(mockSpawn).toHaveBeenCalledWith("gh", ["--version"], expect.any(Object));
      expect(mockSpawn).toHaveBeenCalledWith("gh", ["auth", "login", "--hostname", "github.com", "--with-token"], expect.any(Object));
      expect(mockSpawn).toHaveBeenCalledWith("gh", ["auth", "setup-git", "--hostname", "github.com"], expect.any(Object));
      expect(consoleLogSpy).toHaveBeenCalledWith("Configured GitHub auth for org/repo; gh authenticated; expires at 2026-06-25T13:00:00Z");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses to modify global credentials outside an AK worker unless forced", async () => {
    mockCreateRepositoryGithubToken.mockResolvedValue({
      repository_id: "repo-1",
      full_name: "org/repo",
      token: "ghs_do_not_configure",
      expires_at: "2026-06-25T13:00:00Z",
    });

    await expect(makeProgram().parseAsync(["github", "auth", "repo-1"], { from: "user" })).rejects.toThrow("process.exit called");

    expect(mockCreateRepositoryGithubToken).toHaveBeenCalledWith("repo-1");
    expect(consoleErrorSpy).toHaveBeenCalledWith("Refusing to modify global GitHub credentials outside an AK worker. Use --print-token or --force.");
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("configures credentials outside an AK worker when --force is provided", async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-gh-force-"));
    try {
      mockHomedir.mockReturnValue(home);
      mockCreateRepositoryGithubToken.mockResolvedValue({
        repository_id: "repo-1",
        full_name: "org/repo",
        token: "ghs_force_configure",
        expires_at: "2026-06-25T13:00:00Z",
      });

      await makeProgram().parseAsync(["github", "auth", "repo-1", "--force", "--git-only"], { from: "user" });

      expect(await readFile(join(home, ".git-credentials"), "utf-8")).toBe("https://x-access-token:ghs_force_configure@github.com\n");
      expect(mockSpawn).toHaveBeenCalledWith("git", ["config", "--global", "credential.helper", "store"], expect.any(Object));
      expect(mockSpawn).not.toHaveBeenCalledWith("gh", expect.any(Array), expect.any(Object));
      expect(consoleLogSpy).toHaveBeenCalledWith("Configured GitHub auth for org/repo; gh auth skipped; expires at 2026-06-25T13:00:00Z");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("prints the minted token with --print-token", async () => {
    mockCreateRepositoryGithubToken.mockResolvedValue({
      repository_id: "repo-1",
      full_name: "org/repo",
      token: "ghs_print_me",
      expires_at: "2026-06-25T13:00:00Z",
    });

    await makeProgram().parseAsync(["github", "auth", "repo-1", "--print-token"], { from: "user" });

    expect(mockCreateRepositoryGithubToken).toHaveBeenCalledWith("repo-1");
    expect(consoleLogSpy).toHaveBeenCalledWith("ghs_print_me");
  });
});
