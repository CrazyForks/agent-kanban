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
const mockGetSession = vi.fn();
const mockGetSessionWs = vi.fn();
const mockListTasks = vi.fn();
const mockClient = {
  getTask: mockGetTask,
  getTaskSession: mockGetTaskSession,
  getTaskSessionWs: mockGetTaskSessionWs,
  getSession: mockGetSession,
  getSessionWs: mockGetSessionWs,
  listTasks: mockListTasks,
};
const mockCreateClient = vi.fn(() => Promise.resolve(mockClient));
const mockReadSessionEvents = vi.fn();
const mockFormatSessionEvent = vi.fn(() => "event");
const mockOutput = vi.fn();

vi.mock("../src/agent/leader.js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("../src/sessionWs.js", () => ({
  readSessionEvents: (...args: unknown[]) => mockReadSessionEvents(...args),
}));

// Silence output helpers — we don't test formatting
vi.mock("../src/output.js", () => ({
  getOutputFormat: vi.fn((format?: string) => format ?? "text"),
  output: (...args: unknown[]) => mockOutput(...args),
  formatSessionEvent: (...args: unknown[]) => mockFormatSessionEvent(...args),
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
  formatMaintainer: vi.fn(),
  formatMaintainerList: vi.fn(),
  formatModelList: vi.fn(),
  formatSubagent: vi.fn(),
  formatSubagentList: vi.fn(),
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
  mockGetSession.mockResolvedValue({ session_id: "session-1", session: { state: "idle" } });
  mockGetSessionWs.mockResolvedValue({ url: "wss://session.test" });
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
    expect(errorSpy).toHaveBeenCalledWith("Usage: ak get task <task-id> --session");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("get session", () => {
  it("loads session metadata and events by session id", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42"], { from: "user" });
    expect(mockGetSession).toHaveBeenCalledWith("session-42");
    expect(mockGetSessionWs).toHaveBeenCalledWith("session-42");
    expect(mockGetTaskSession).not.toHaveBeenCalled();
    expect(mockGetTaskSessionWs).not.toHaveBeenCalled();
    expect(mockReadSessionEvents).toHaveBeenCalledWith(
      "wss://session.test",
      expect.objectContaining({ all: undefined, watch: undefined, filter: "all", recentLimit: 20 }),
    );
  });

  it("passes --watch, --all, and --tool to the WebSocket event reader", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42", "--watch", "--all", "--tool"], { from: "user" });
    expect(mockReadSessionEvents).toHaveBeenCalledWith("wss://session.test", expect.objectContaining({ all: true, watch: true, filter: "tool" }));
  });

  it("passes --limit to the WebSocket event reader", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42", "--limit", "5"], { from: "user" });
    expect(mockReadSessionEvents).toHaveBeenCalledWith("wss://session.test", expect.objectContaining({ recentLimit: 5 }));
  });

  it("passes --verbose to the session event formatter", async () => {
    mockReadSessionEvents.mockImplementationOnce(async (_url, options) => {
      options.onEvent?.({ sequence: 1, type: "tool_execution_end" });
      return [];
    });
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42", "--verbose"], { from: "user" });
    expect(mockFormatSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }), "all", expect.objectContaining({ verbose: true }));
  });

  it("supports json output with collected events", async () => {
    mockReadSessionEvents.mockResolvedValueOnce([{ sequence: 1, type: "message_end" }]);
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42", "-o", "json"], { from: "user" });
    expect(mockOutput).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "session-1", events: [{ sequence: 1, type: "message_end" }] }),
      "json",
      undefined,
      expect.objectContaining({ kind: "session" }),
    );
  });

  it("rejects invalid --limit values", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "session", "session-42", "--limit", "nope"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(errorSpy).toHaveBeenCalledWith("--limit must be a positive number");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects combining --tool and --assistant", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "session", "task-42", "--tool", "--assistant"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(errorSpy).toHaveBeenCalledWith("--tool and --assistant cannot be used together");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
