import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSessionEvents } from "../src/sessionWs.js";

let sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: any[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function event(sequence: number, type = "message.completed", payload: Record<string, unknown> = {}) {
  return { id: `event-${sequence}`, sessionId: "session-1", sequence, createdAt: "2026-07-01T00:00:00.000Z", type, payload };
}

function assistantTextEvent(sequence: number, text: string) {
  return event(sequence, "message.completed", { message: { role: "assistant", content: [{ type: "text", text }] } });
}

function toolCallEvent(sequence: number) {
  return event(sequence, "message.completed", {
    message: { role: "assistant", content: [{ type: "tool_call", toolCall: { id: "call-1", name: "bash", input: { command: "echo ok" } } }] },
  });
}

it("requests recent events over WebSocket by default", async () => {
  const promise = readSessionEvents("wss://session.test");
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ id: "backfill-1", type: "backfill", requestId: "backfill-1", limit: 20 }));
  sockets[0].emit({ type: "backfill", events: [event(3), event(2)], hasMore: false });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 2 }), expect.objectContaining({ sequence: 3 })]);
});

it("trims recent events locally when the server returns too many", async () => {
  const seen: number[] = [];
  const promise = readSessionEvents("wss://session.test", { recentLimit: 2, onEvent: (item) => seen.push(item.sequence) });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ id: "backfill-1", type: "backfill", requestId: "backfill-1", limit: 2 }));
  sockets[0].emit({ type: "backfill", events: [event(4), event(3), event(2), event(1)], hasMore: false });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 3 }), expect.objectContaining({ sequence: 4 })]);
  expect(seen).toEqual([3, 4]);
});

it("follows backfill pages when --all is enabled", async () => {
  const promise = readSessionEvents("wss://session.test", { all: true });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ id: "backfill-1", type: "backfill", requestId: "backfill-1", limit: 200 }));
  sockets[0].emit({ type: "backfill", events: [event(1)], hasMore: true, nextCursor: 1 });
  await vi.waitFor(() =>
    expect(sockets[0]?.sent[1]).toMatchObject({ id: "backfill-2", type: "backfill", requestId: "backfill-2", limit: 200, cursor: 1 }),
  );
  sockets[0].emit({ type: "backfill", events: [event(2)], hasMore: false });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 1 }), expect.objectContaining({ sequence: 2 })]);
  expect(sockets[0].closed).toBe(true);
});

it("does not follow malformed string cursors", async () => {
  const promise = readSessionEvents("wss://session.test", { all: true });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ id: "backfill-1", type: "backfill", requestId: "backfill-1", limit: 200 }));
  sockets[0].emit({ type: "backfill", events: [event(1)], hasMore: true, nextCursor: "cursor-1" });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 1 })]);
  expect(sockets[0].sent).toHaveLength(1);
});

it("rejects server error frames immediately", async () => {
  const promise = readSessionEvents("wss://session.test", { backfillTimeoutMs: 10_000 });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toBeDefined());
  sockets[0].emit({ type: "error", message: "Invalid session socket message" });
  await expect(promise).rejects.toThrow("Invalid session socket message");
});

it("rejects runner unavailable frames immediately", async () => {
  const promise = readSessionEvents("wss://session.test", { backfillTimeoutMs: 10_000 });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toBeDefined());
  sockets[0].emit({ type: "runner_unavailable", message: "runner offline" });
  await expect(promise).rejects.toThrow("runner offline");
});

it("filters assistant text events", async () => {
  const promise = readSessionEvents("wss://session.test", { filter: "assistant" });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toBeDefined());
  sockets[0].emit({
    type: "backfill",
    events: [assistantTextEvent(1, "hello"), toolCallEvent(2)],
    hasMore: false,
  });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 1 })]);
});

it("filters tool events", async () => {
  const promise = readSessionEvents("wss://session.test", { filter: "tool" });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toBeDefined());
  sockets[0].emit({
    type: "backfill",
    events: [assistantTextEvent(1, "hello"), toolCallEvent(2)],
    hasMore: false,
  });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 2 })]);
});
