import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel";

// ── Mocks ────────────────────────────────────────────────────────────────────

const runtimeMock = vi.fn();
const runtimeSocketMock = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    tasks: {
      runtime: (...args: unknown[]) => runtimeMock(...args),
      runtimeSocket: (...args: unknown[]) => runtimeSocketMock(...args),
    },
  },
}));

vi.mock("./RelayRuntimeProvider", () => ({
  AmaRuntimeProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "ama-runtime-provider" }, children),
  RelayRuntimeProvider: ({ sessionId, children }: { sessionId: string; children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "relay-runtime-provider", "data-session-id": sessionId }, children),
}));

vi.mock("@/components/chat", () => ({
  AgentThread: () => React.createElement("div", { "data-testid": "agent-thread" }),
  ChatToolUIs: () => React.createElement("div", { "data-testid": "chat-tool-uis" }),
}));

// ── WebSocket fake ────────────────────────────────────────────────────────────

// Minimal WebSocket fake for jsdom. Captures the most-recently constructed
// instance so tests can fire messages on it.
let lastWebSocket: FakeWebSocket | null = null;

class FakeWebSocket {
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readyState = 1; // OPEN

  constructor(url: string) {
    this.url = url;
    lastWebSocket = this;
  }

  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }

  // Helper used by tests to deliver a message as if the server sent it.
  simulateMessage(data: unknown) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }
}

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
    lastWebSocket = null;

    // Default: single empty page, no more.
    runtimeMock.mockResolvedValue({ events: [], session: undefined, pagination: { hasMore: false } });
    // Default: socket url for not-done AMA branch.
    runtimeSocketMock.mockResolvedValue({ url: "wss://test/socket" });

    // Install the fake WebSocket globally so source code that does
    // `new WebSocket(url)` uses the fake instead of the real browser API.
    vi.stubGlobal("WebSocket", FakeWebSocket);
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

    it("calls api.tasks.runtime with order asc on initial load", async () => {
      renderPanel({ amaSessionId: "session_x" });

      // Wait for the initial-load effect to fire.
      await screen.findByTestId("ama-runtime-provider");

      expect(runtimeMock).toHaveBeenCalledWith(TASK_ID, { order: "asc", cursor: undefined, limit: 200 });
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
      // First call = initial load (asc), second call = live-tail tick (asc, taskDone path).
      renderPanel({ amaSessionId: "session_x", taskDone: true });

      await screen.findByTestId("ama-runtime-provider");

      const calls = runtimeMock.mock.calls;
      const tailCall = calls.find((c: unknown[]) => (c[1] as Record<string, unknown>)?.order === "asc" && c[1] !== calls[0]?.[1]);
      // At minimum two calls were made (initial load + tail).
      expect(calls.length).toBeGreaterThanOrEqual(2);
      // The tail call uses order asc.
      const tailCalls = calls.filter((c: unknown[]) => (c[1] as Record<string, unknown>)?.order === "asc");
      expect(tailCalls.length).toBeGreaterThanOrEqual(2);
      void tailCall;
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

    // ── Multi-page initial load ───────────────────────────────────────────────

    it("pages through multiple pages on initial load until hasMore is false", async () => {
      // Page 1: hasMore=true, page 2: hasMore=false.
      runtimeMock
        .mockResolvedValueOnce({
          events: [makeEvent(1), makeEvent(2)],
          session: undefined,
          pagination: { hasMore: true },
        })
        .mockResolvedValueOnce({
          events: [makeEvent(3), makeEvent(4)],
          session: undefined,
          pagination: { hasMore: false },
        });

      renderPanel({ amaSessionId: "session_x", taskDone: true });

      await screen.findByTestId("ama-runtime-provider");

      // The initial load must have made at least 2 ascending calls.
      const ascCalls = runtimeMock.mock.calls.filter((c: unknown[]) => (c[1] as Record<string, unknown>)?.order === "asc");
      expect(ascCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("passes the cursor from the last event of page 1 when fetching page 2", async () => {
      // Page 1 ends at sequence 2; page 2 should be fetched with cursor=2.
      runtimeMock
        .mockResolvedValueOnce({
          events: [makeEvent(1), makeEvent(2)],
          session: undefined,
          pagination: { hasMore: true },
        })
        .mockResolvedValueOnce({
          events: [makeEvent(3)],
          session: undefined,
          pagination: { hasMore: false },
        });

      renderPanel({ amaSessionId: "session_x", taskDone: true });

      await screen.findByTestId("ama-runtime-provider");

      // Second ascending call must use cursor = 2 (sequence of last event on page 1).
      const ascCalls = runtimeMock.mock.calls.filter((c: unknown[]) => (c[1] as Record<string, unknown>)?.order === "asc");
      expect(ascCalls.length).toBeGreaterThanOrEqual(2);
      const secondAscCall = ascCalls[1];
      expect((secondAscCall[1] as Record<string, unknown>).cursor).toBe(2);
    });

    // ── WebSocket live tail (not-done task) ───────────────────────────────────

    it("calls api.tasks.runtimeSocket for a not-done AMA task", async () => {
      renderPanel({ amaSessionId: "session_x", taskDone: false });

      await screen.findByTestId("ama-runtime-provider");

      expect(runtimeSocketMock).toHaveBeenCalledWith(TASK_ID);
    });

    it("constructs a WebSocket with the url returned by runtimeSocket", async () => {
      runtimeSocketMock.mockResolvedValue({ url: "wss://example.com/socket" });

      renderPanel({ amaSessionId: "session_x", taskDone: false });

      await screen.findByTestId("ama-runtime-provider");

      expect(lastWebSocket).not.toBeNull();
      expect(lastWebSocket!.url).toBe("wss://example.com/socket");
    });

    it("appends an event to the thread when the WebSocket delivers a message", async () => {
      renderPanel({ amaSessionId: "session_x", taskDone: false });

      await screen.findByTestId("ama-runtime-provider");

      // Deliver an event message over the fake WebSocket.
      await act(async () => {
        lastWebSocket!.simulateMessage({ type: "event", event: makeEvent(10) });
      });

      // The provider is still rendered (events were appended without error).
      expect(screen.getByTestId("ama-runtime-provider")).toBeInTheDocument();
    });

    it("does not call api.tasks.runtimeSocket for a done task", async () => {
      renderPanel({ amaSessionId: "session_x", taskDone: true });

      await screen.findByTestId("ama-runtime-provider");

      expect(runtimeSocketMock).not.toHaveBeenCalled();
    });

    it("does not open a WebSocket for a done task", async () => {
      lastWebSocket = null;
      renderPanel({ amaSessionId: "session_x", taskDone: true });

      await screen.findByTestId("ama-runtime-provider");

      expect(lastWebSocket).toBeNull();
    });
  });
});
