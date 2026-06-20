import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel";

// ── Mocks ────────────────────────────────────────────────────────────────────

const runtimeMock = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    tasks: {
      runtime: (...args: unknown[]) => runtimeMock(...args),
    },
  },
}));

vi.mock("./RelayRuntimeProvider", () => ({
  AmaRuntimeProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "ama-runtime-provider" }, children),
  RelayRuntimeProvider: ({ sessionId, children }: { sessionId: string; children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "relay-runtime-provider", "data-session-id": sessionId }, children),
}));

// AgentThread mock captures the onLoadOlder callback so tests can invoke it.
let capturedOnLoadOlder: (() => void) | undefined;

vi.mock("@/components/chat", () => ({
  AgentThread: ({ onLoadOlder }: { onLoadOlder?: () => void }) => {
    capturedOnLoadOlder = onLoadOlder;
    return React.createElement("div", { "data-testid": "agent-thread" });
  },
  ChatToolUIs: () => React.createElement("div", { "data-testid": "chat-tool-uis" }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(sequence: number): Record<string, unknown> {
  return { sequence, type: "text", content: `event-${sequence}` };
}

const TASK_ID = "task-123";
const AGENT_ID = "agent-456";

function renderPanel(props: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  return render(
    React.createElement(ChatPanel, {
      taskId: TASK_ID,
      agentId: AGENT_ID,
      taskDone: false,
      ...props,
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnLoadOlder = undefined;
    runtimeMock.mockResolvedValue({ events: [], session: undefined, pagination: { hasMore: false } });
  });

  describe("branch 1: agentId is null", () => {
    it("renders the no-agent-assigned message", () => {
      renderPanel({ agentId: null });

      expect(screen.getByText("No agent assigned. Chat is available when an agent is working on this task.")).toBeInTheDocument();
    });

    it("does not call api.tasks.runtime", () => {
      renderPanel({ agentId: null });

      expect(runtimeMock).not.toHaveBeenCalled();
    });
  });

  describe("branch 2: agentId set + amaSessionId present", () => {
    it("renders the AMA runtime provider marker", async () => {
      renderPanel({ amaSessionId: "session_x" });

      // AmaSessionChat enters the "loading" phase first; once the mock resolves
      // it transitions to "ready" and mounts AmaRuntimeProvider.
      expect(await screen.findByTestId("ama-runtime-provider")).toBeInTheDocument();
    });

    it("calls api.tasks.runtime with the taskId", async () => {
      renderPanel({ amaSessionId: "session_x" });

      // Wait for the initial-load effect to fire.
      await screen.findByTestId("ama-runtime-provider");

      expect(runtimeMock).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ order: "desc" }));
    });

    it("does not render the relay provider", async () => {
      renderPanel({ amaSessionId: "session_x" });

      await screen.findByTestId("ama-runtime-provider");

      expect(screen.queryByTestId("relay-runtime-provider")).not.toBeInTheDocument();
    });
  });

  describe("branch 3: agentId set + no amaSessionId + relaySessionId present", () => {
    it("renders the relay runtime provider marker", () => {
      renderPanel({ amaSessionId: null, relaySessionId: "relay_x" });

      expect(screen.getByTestId("relay-runtime-provider")).toBeInTheDocument();
    });

    it("threads the relaySessionId through to RelayRuntimeProvider", () => {
      renderPanel({ amaSessionId: null, relaySessionId: "relay_x" });

      expect(screen.getByTestId("relay-runtime-provider")).toHaveAttribute("data-session-id", "relay_x");
    });

    it("does not call api.tasks.runtime", () => {
      renderPanel({ amaSessionId: null, relaySessionId: "relay_x" });

      expect(runtimeMock).not.toHaveBeenCalled();
    });

    it("does not render the AMA provider", () => {
      renderPanel({ amaSessionId: null, relaySessionId: "relay_x" });

      expect(screen.queryByTestId("ama-runtime-provider")).not.toBeInTheDocument();
    });
  });

  describe("branch 4: agentId set + both session ids absent", () => {
    it("renders the chat-history-not-available message", () => {
      renderPanel({ amaSessionId: null, relaySessionId: null });

      expect(screen.getByText("Chat history is not available for this task.")).toBeInTheDocument();
    });

    it("does not render either runtime provider", () => {
      renderPanel({ amaSessionId: null, relaySessionId: null });

      expect(screen.queryByTestId("ama-runtime-provider")).not.toBeInTheDocument();
      expect(screen.queryByTestId("relay-runtime-provider")).not.toBeInTheDocument();
    });
  });

  describe("AmaSessionChat internal states", () => {
    it("shows loading state before api resolves", () => {
      // Hold the promise so the component stays in loading phase.
      let resolve!: (v: unknown) => void;
      runtimeMock.mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      );

      renderPanel({ amaSessionId: "session_x" });

      expect(screen.getByText("Loading runtime history...")).toBeInTheDocument();

      // Resolve to avoid unhandled promise rejection after test ends.
      act(() => {
        resolve({ events: [], session: undefined, pagination: { hasMore: false } });
      });
    });

    it("shows error state when api.tasks.runtime rejects", async () => {
      runtimeMock.mockRejectedValue(new Error("network error"));

      renderPanel({ amaSessionId: "session_x" });

      expect(await screen.findByText("Session history is not available for this task.")).toBeInTheDocument();
    });

    it("renders the AMA provider when taskDone=true after api resolves", async () => {
      renderPanel({ amaSessionId: "session_x", taskDone: true });

      // The taskDone=true path fires tick() once then returns; we still reach "ready".
      expect(await screen.findByTestId("ama-runtime-provider")).toBeInTheDocument();
    });

    it("calls api.tasks.runtime for live tail when taskDone=true", async () => {
      // First call = initial load (desc), second call = live-tail tick (asc, taskDone path).
      renderPanel({ amaSessionId: "session_x", taskDone: true });

      await screen.findByTestId("ama-runtime-provider");

      const calls = runtimeMock.mock.calls;
      const tailCall = calls.find((c: unknown[]) => (c[1] as Record<string, unknown>)?.order === "asc");
      expect(tailCall).toBeDefined();
    });

    it("merges new events returned by the live-tail tick into the display list", async () => {
      // Initial load returns event seq=1; live tail returns seq=2 so mergeUnique runs.
      runtimeMock
        .mockResolvedValueOnce({ events: [makeEvent(1)], session: undefined, pagination: { hasMore: false } })
        .mockResolvedValueOnce({ events: [makeEvent(2)], session: undefined, pagination: { hasMore: false } });

      renderPanel({ amaSessionId: "session_x", taskDone: true });

      // After both calls resolve the provider should still be present.
      expect(await screen.findByTestId("ama-runtime-provider")).toBeInTheDocument();
      // Both calls were made (initial + tail).
      expect(runtimeMock).toHaveBeenCalledTimes(2);
    });

    it("exposes onLoadOlder callback when hasMore is true and invokes api on call", async () => {
      // Initial load with hasMore=true so onLoadOlder is wired into AgentThread.
      runtimeMock.mockResolvedValueOnce({
        events: [makeEvent(5)],
        session: undefined,
        pagination: { hasMore: true },
      });
      // loadOlder call returns an older page.
      runtimeMock.mockResolvedValueOnce({
        events: [makeEvent(3), makeEvent(4)],
        session: undefined,
        pagination: { hasMore: false },
      });

      renderPanel({ amaSessionId: "session_x" });

      await screen.findByTestId("ama-runtime-provider");

      // capturedOnLoadOlder should be set because hasMore=true.
      expect(capturedOnLoadOlder).toBeDefined();

      // Trigger load-older.
      await act(async () => {
        await capturedOnLoadOlder!();
      });

      // api.tasks.runtime should have been called a second time (for loadOlder).
      expect(runtimeMock).toHaveBeenCalledTimes(2);
      const olderCall = runtimeMock.mock.calls[1];
      expect((olderCall[1] as Record<string, unknown>).order).toBe("desc");
    });
  });
});
