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

function sessionEvent(id: string, sequence: number, createdAt: string) {
  return {
    id,
    sessionId: "session-1",
    sequence,
    createdAt,
    type: "message.completed",
    payload: {
      message: {
        id: `message-${id}`,
        role: "assistant",
        content: [{ type: "text", text: id }],
      },
    },
  };
}

function idlessSessionEvent(messageId: string, sequence: number, text: string) {
  return {
    sessionId: "session-1",
    sequence,
    createdAt: "2026-07-03T10:00:00.000Z",
    type: "message.completed",
    payload: {
      message: {
        id: messageId,
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
  };
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
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 20 }));
  expect(sockets[0]?.sent[0]).not.toHaveProperty("id");
  sockets[0].emit({ type: "backfill", events: [event(3), event(2)], hasMore: false });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 2 }), expect.objectContaining({ sequence: 3 })]);
});

it("trims recent events locally when the server returns too many", async () => {
  const seen: number[] = [];
  const promise = readSessionEvents("wss://session.test", { recentLimit: 2, onEvent: (item) => seen.push(item.sequence) });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 2 }));
  expect(sockets[0]?.sent[0]).not.toHaveProperty("id");
  sockets[0].emit({ type: "backfill", events: [event(4), event(3), event(2), event(1)], hasMore: false });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 3 }), expect.objectContaining({ sequence: 4 })]);
  expect(seen).toEqual([3, 4]);
});

it("follows backfill pages when --all is enabled", async () => {
  const promise = readSessionEvents("wss://session.test", { all: true });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));
  expect(sockets[0]?.sent[0]).not.toHaveProperty("id");
  sockets[0].emit({ type: "backfill", events: [event(1)], hasMore: true, nextCursor: 1 });
  await vi.waitFor(() => expect(sockets[0]?.sent[1]).toMatchObject({ type: "backfill", requestId: "backfill-2", limit: 200, cursor: 1 }));
  expect(sockets[0]?.sent[1]).not.toHaveProperty("id");
  sockets[0].emit({ type: "backfill", events: [event(2)], hasMore: false });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 1 }), expect.objectContaining({ sequence: 2 })]);
  expect(sockets[0].closed).toBe(true);
});

it("deduplicates by stable event id and sorts by creation time then sequence", async () => {
  const seen: string[] = [];
  const promise = readSessionEvents("wss://session.test", {
    all: true,
    watch: true,
    onEvent: (item) => seen.push(item.id),
    backfillTimeoutMs: 10_000,
  });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));

  const sameSequenceLater = sessionEvent("same-sequence-later", 7, "2026-07-03T10:00:03.000Z");
  const duplicate = sessionEvent("duplicate", 8, "2026-07-03T10:00:04.000Z");
  const sameSequenceEarlier = sessionEvent("same-sequence-earlier", 7, "2026-07-03T10:00:01.000Z");
  const sameTimeLowerSequence = sessionEvent("same-time-lower-sequence", 2, "2026-07-03T10:00:02.000Z");
  const sameTimeHigherSequence = sessionEvent("same-time-higher-sequence", 5, "2026-07-03T10:00:02.000Z");

  sockets[0].emit({ type: "backfill", events: [sameSequenceLater, duplicate], hasMore: true, nextCursor: 1 });
  await vi.waitFor(() => expect(sockets[0]?.sent[1]).toMatchObject({ type: "backfill", requestId: "backfill-2", limit: 200, cursor: 1 }));
  sockets[0].emit({ type: "backfill", events: [sameSequenceEarlier, duplicate, sameTimeHigherSequence], hasMore: false });
  sockets[0].emit({ type: "event", record: duplicate });
  sockets[0].emit({ type: "event", record: sameTimeLowerSequence });
  sockets[0].onclose?.();

  await expect(promise).resolves.toEqual([
    expect.objectContaining({ id: "same-sequence-earlier", sequence: 7 }),
    expect.objectContaining({ id: "same-time-lower-sequence", sequence: 2 }),
    expect.objectContaining({ id: "same-time-higher-sequence", sequence: 5 }),
    expect.objectContaining({ id: "same-sequence-later", sequence: 7 }),
    expect.objectContaining({ id: "duplicate", sequence: 8 }),
  ]);
  expect(seen).toEqual(["same-sequence-later", "duplicate", "same-sequence-earlier", "same-time-higher-sequence", "same-time-lower-sequence"]);
});

it("deduplicates id-less events by message id without collapsing distinct messages at the same sequence", async () => {
  const promise = readSessionEvents("wss://session.test", { all: true });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));

  const first = idlessSessionEvent("message-a", 42, "first message");
  const duplicate = idlessSessionEvent("message-a", 42, "duplicate message");
  const distinctSameSequence = idlessSessionEvent("message-b", 42, "same sequence, different message");

  sockets[0].emit({ type: "backfill", events: [first, duplicate, distinctSameSequence], hasMore: false });

  const result = await promise;
  expect(result).toHaveLength(2);
  expect(result.every((item) => !("id" in item))).toBe(true);
  expect(result.map((item) => item.payload.message.id)).toEqual(["message-a", "message-b"]);
  expect(result.map((item) => item.payload.message.content[0].text)).toEqual(["first message", "same sequence, different message"]);
});

it("does not follow malformed string cursors", async () => {
  const promise = readSessionEvents("wss://session.test", { all: true });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));
  expect(sockets[0]?.sent[0]).not.toHaveProperty("id");
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
