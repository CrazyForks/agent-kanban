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

function isToolEvent(event: SessionEvent): boolean {
  const type = String(event.type ?? "");
  if (type.startsWith("tool_execution_")) return true;
  const embeddedType = event.payload?.event?.type;
  if (embeddedType === "block.start" || embeddedType === "block.done") {
    const blockType = event.payload?.event?.block?.type;
    return blockType === "tool_use" || blockType === "tool_result";
  }
  return false;
}

function eventText(event: SessionEvent): string {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const embedded = payload.event && typeof payload.event === "object" ? payload.event : null;
  if (embedded?.type === "message" && Array.isArray(embedded.blocks)) {
    return embedded.blocks
      .map((block: any) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("");
  }

  if (event.type === "message_end") {
    return messageContentText(payload.message?.content);
  }

  if (event.type === "runtime.output" && typeof payload.content === "string") return payload.content;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.message === "string") return payload.message;
  return "";
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
  if (event.role && event.role !== "assistant" && event.role !== "agent") return false;
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
  const order = options.all ? "asc" : "desc";

  return new Promise((resolve, reject) => {
    let settled = false;
    let initialBackfillComplete = false;
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
        if (settled) return;
        settled = true;
        closeSocket();
        reject(new Error("Session WebSocket backfill timed out"));
      }, options.backfillTimeoutMs ?? 30_000);
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

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "backfill", order, limit }));
      armTimeout();
    };

    ws.onerror = (event: any) => {
      if (!settled) {
        const detail = typeof event?.message === "string" ? `: ${event.message}` : "";
        reject(new Error(`Session WebSocket failed${detail}`));
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
        if (!settled) reject(error);
        return;
      }
      if (frame?.type === "backfill" && Array.isArray(frame.events)) {
        armTimeout();
        const page = options.all ? frame.events : [...frame.events].reverse();
        for (const event of page) accept(event);
        if (options.all && frame.hasMore && frame.nextCursor !== undefined && frame.nextCursor !== null) {
          ws.send(JSON.stringify({ type: "backfill", order: "asc", limit: 200, cursor: frame.nextCursor }));
          return;
        }
        initialBackfillComplete = true;
        if (!options.watch) finish();
        return;
      }

      if (frame?.type === "event" && frame.event) {
        if (!initialBackfillComplete && !options.watch) return;
        accept(frame.event);
      }
    };
  });
}
