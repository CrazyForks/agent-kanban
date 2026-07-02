export type SessionEvent = Record<string, any>;

export type SessionEventFilter = "all" | "tool" | "assistant";

export interface ReadSessionEventsOptions {
  all?: boolean;
  watch?: boolean;
  filter?: SessionEventFilter;
  recentLimit?: number;
  onEvent?: (event: SessionEvent) => void;
  backfillTimeoutMs?: number;
}

function eventSequence(event: SessionEvent): number {
  const sequence = Number(event.sequence);
  return Number.isFinite(sequence) ? sequence : 0;
}

function objectValue(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function runtimeEvent(event: SessionEvent): Record<string, any> | null {
  return objectValue(event);
}

function runtimePayload(event: SessionEvent): Record<string, any> {
  return objectValue(event.payload) ?? {};
}

function runtimeMessage(event: SessionEvent): Record<string, any> | null {
  return objectValue(runtimePayload(event).message);
}

function isToolEvent(event: SessionEvent): boolean {
  const type = String(runtimeEvent(event)?.type ?? "");
  if (type !== "message.started" && type !== "message.updated" && type !== "message.completed") return false;
  const content = runtimeMessage(event)?.content;
  return Array.isArray(content) && content.some((part) => part?.type === "tool_call" || part?.type === "tool_result");
}

function eventText(event: SessionEvent): string {
  return messageContentText(runtimeMessage(event)?.content);
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

export function isAssistantEvent(event: SessionEvent): boolean {
  const role = runtimeMessage(event)?.role;
  if (role !== "assistant" && role !== "agent") return false;
  return eventText(event).trim().length > 0;
}

export function sessionEventText(event: SessionEvent): string {
  return eventText(event);
}

export function matchesSessionEventFilter(event: SessionEvent, filter: SessionEventFilter = "all"): boolean {
  if (filter === "tool") return isToolEvent(event);
  if (filter === "assistant") return isAssistantEvent(event);
  return true;
}

function connect(url: string): { ws: any; abort: () => void } {
  const WebSocketCtor = (globalThis as any).WebSocket;
  if (!WebSocketCtor) throw new Error("WebSocket is not available in this Node runtime");
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  try {
    return {
      ws: new WebSocketCtor(url, [], controller ? { signal: controller.signal } : undefined),
      abort: () => controller?.abort(),
    };
  } catch {
    return { ws: new WebSocketCtor(url), abort: () => controller?.abort() };
  }
}

export async function readSessionEvents(url: string, options: ReadSessionEventsOptions = {}): Promise<SessionEvent[]> {
  const filter = options.filter ?? "all";
  const seen = new Set<number>();
  const events: SessionEvent[] = [];
  const limit = options.all ? 200 : (options.recentLimit ?? 20);

  return new Promise((resolve, reject) => {
    let settled = false;
    let initialBackfillComplete = false;
    let backfillSeq = 0;
    const connection = connect(url);
    const { ws } = connection;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const closeSocket = () => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        connection.abort();
        ws.close();
      } catch {
        // The promise has already settled; there is nothing useful to report.
      }
    };

    const armTimeout = () => {
      if (options.watch) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        fail(new Error("Session WebSocket backfill timed out"));
      }, options.backfillTimeoutMs ?? 30_000);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      closeSocket();
      reject(error);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      closeSocket();
      events.sort((a, b) => eventSequence(a) - eventSequence(b));
      if (!options.all && events.length > limit) {
        events.splice(0, events.length - limit);
      }
      if (!options.watch) {
        for (const event of events) options.onEvent?.(event);
      }
      resolve(events);
    };

    const accept = (event: SessionEvent) => {
      const sequence = eventSequence(event);
      if (seen.has(sequence)) return;
      seen.add(sequence);
      if (!matchesSessionEventFilter(event, filter)) return;
      events.push(event);
      if (options.watch) options.onEvent?.(event);
    };

    const sendBackfill = (params: { cursor?: number } = {}) => {
      const requestId = `backfill-${++backfillSeq}`;
      ws.send(JSON.stringify({ type: "backfill", requestId, limit, ...params }));
    };

    ws.onopen = () => {
      sendBackfill();
      armTimeout();
    };

    ws.onerror = (event: any) => {
      if (!settled) {
        const detail = typeof event?.message === "string" ? `: ${event.message}` : "";
        fail(new Error(`Session WebSocket failed${detail}`));
      }
    };

    ws.onclose = () => {
      if (!settled) finish();
    };

    ws.onmessage = (message: any) => {
      const raw = typeof message.data === "string" ? message.data : "";
      let frame: any;
      try {
        frame = raw ? JSON.parse(raw) : null;
      } catch (error) {
        if (error instanceof Error) fail(error);
        else fail(new Error(String(error)));
        return;
      }
      if (frame?.type === "error" && typeof frame.message === "string") {
        fail(new Error(frame.message));
        return;
      }
      if (frame?.type === "runner_unavailable" && typeof frame.message === "string") {
        fail(new Error(frame.message));
        return;
      }
      if (frame?.type === "backfill" && Array.isArray(frame.events)) {
        armTimeout();
        const page = options.all ? frame.events : [...frame.events].reverse();
        for (const event of page) accept(event);
        if (options.all && frame.hasMore && typeof frame.nextCursor === "number") {
          sendBackfill({ cursor: frame.nextCursor });
          return;
        }
        initialBackfillComplete = true;
        if (!options.watch) finish();
        return;
      }

      if (frame?.type === "event" && frame.record) {
        if (!initialBackfillComplete && !options.watch) return;
        accept(frame.record);
      }
    };
  });
}
