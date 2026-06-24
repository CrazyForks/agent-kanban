// @vitest-environment node
/**
 * Tests for `get task` command handler in commands/get.ts.
 *
 * Covers the --board required validation added to list mode:
 *   - `ak get task` (no id, no --board) → error + process.exit(1)
 *   - `ak get task --board <id>` → calls client.listTasks with board_id param
 *   - `ak get task <id>` (no --board) → calls client.getTask, no error
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock createClient before importing the command ────────────────────────────

const mockGetTask = vi.fn();
const mockGetTaskSession = vi.fn();
const mockGetTaskSessionWs = vi.fn();
const mockListTasks = vi.fn();
const mockClient = {
  getTask: mockGetTask,
  getTaskSession: mockGetTaskSession,
  getTaskSessionWs: mockGetTaskSessionWs,
  listTasks: mockListTasks,
};
const mockCreateClient = vi.fn(() => Promise.resolve(mockClient));
const mockReadSessionEvents = vi.fn();

vi.mock("../src/agent/leader.js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("../src/sessionWs.js", () => ({
  readSessionEvents: (...args: unknown[]) => mockReadSessionEvents(...args),
}));

// Silence output helpers — we don't test formatting
vi.mock("../src/output.js", () => ({
  getOutputFormat: vi.fn(() => "text"),
  output: vi.fn(),
  formatSessionEvent: vi.fn(() => "event"),
  formatTask: vi.fn(),
  formatTaskList: vi.fn(),
  formatTaskListWide: vi.fn(),
  formatTaskSession: vi.fn(() => "session"),
  formatBoard: vi.fn(),
  formatBoardList: vi.fn(),
  formatAgent: vi.fn(),
  formatAgentList: vi.fn(),
  formatRepository: vi.fn(),
  formatRepositoryList: vi.fn(),
  formatTaskNotes: vi.fn(),
}));

const { registerGetCommand } = await import("../src/commands/get.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevents real process.exit inside commander's own validation
  registerGetCommand(program);
  return program;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockListTasks.mockResolvedValue([]);
  mockGetTask.mockResolvedValue({ id: "task-1", title: "Test task" });
  mockGetTaskSession.mockResolvedValue({ task_id: "task-1", session_id: "session-1", session: { state: "idle" } });
  mockGetTaskSessionWs.mockResolvedValue({ url: "wss://session.test" });
  mockReadSessionEvents.mockResolvedValue([]);

  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as any);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  errorSpy.mockRestore();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("get task — list mode without --board", () => {
  it("prints an error message when --board is omitted", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "task"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(errorSpy).toHaveBeenCalledWith("Error: --board is required when listing tasks\nUsage: ak get task --board <id>");
  });

  it("exits with code 1 when --board is omitted", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "task"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not call client.listTasks when --board is omitted", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "task"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(mockListTasks).not.toHaveBeenCalled();
  });
});

describe("get task — list mode with --board", () => {
  it("calls client.listTasks with board_id when --board is provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "--board", "board-abc"], { from: "user" });
    expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ board_id: "board-abc" }));
  });

  it("does not call process.exit when --board is provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "--board", "board-abc"], { from: "user" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("passes --status filter to listTasks when provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "--board", "board-abc", "--status", "in_progress"], { from: "user" });
    expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ board_id: "board-abc", status: "in_progress" }));
  });

  it("passes --label filter to listTasks when provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "--board", "board-abc", "--label", "bug"], { from: "user" });
    expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ board_id: "board-abc", label: "bug" }));
  });

  it("passes --repo filter as repository_id to listTasks when provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "--board", "board-abc", "--repo", "repo-xyz"], { from: "user" });
    expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ board_id: "board-abc", repository_id: "repo-xyz" }));
  });
});

describe("get task — single-task fetch by ID", () => {
  it("calls client.getTask with the provided id", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "task-42"], { from: "user" });
    expect(mockGetTask).toHaveBeenCalledWith("task-42");
  });

  it("does not call process.exit when an id is provided without --board", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "task-42"], { from: "user" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not call client.listTasks when an id is provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "task-42"], { from: "user" });
    expect(mockListTasks).not.toHaveBeenCalled();
  });

  it("calls client.getTaskSession instead of client.getTask when --session is provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "task-42", "--session"], { from: "user" });
    expect(mockGetTaskSession).toHaveBeenCalledWith("task-42");
    expect(mockGetTaskSessionWs).toHaveBeenCalledWith("task-42");
    expect(mockGetTask).not.toHaveBeenCalled();
  });

  it("requires a task id when --session is provided", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "task", "--session"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(errorSpy).toHaveBeenCalledWith("Usage: ak get session <task-id>");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("get session", () => {
  it("loads session metadata and events for a task", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "session", "task-42"], { from: "user" });
    expect(mockGetTaskSession).toHaveBeenCalledWith("task-42");
    expect(mockGetTaskSessionWs).toHaveBeenCalledWith("task-42");
    expect(mockReadSessionEvents).toHaveBeenCalledWith(
      "wss://session.test",
      expect.objectContaining({ all: undefined, watch: undefined, filter: "all" }),
    );
  });

  it("passes --watch, --all, and --tool to the WebSocket event reader", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "session", "task-42", "--watch", "--all", "--tool"], { from: "user" });
    expect(mockReadSessionEvents).toHaveBeenCalledWith("wss://session.test", expect.objectContaining({ all: true, watch: true, filter: "tool" }));
  });

  it("rejects combining --tool and --assistant", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "session", "task-42", "--tool", "--assistant"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(errorSpy).toHaveBeenCalledWith("--tool and --assistant cannot be used together");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
