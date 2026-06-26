import { useEffect, useState } from "react";
import { AgentThread, ChatToolUIs } from "@/components/chat";
import { api } from "../lib/api";
import { AmaRuntimeProvider, RelayRuntimeProvider } from "./RelayRuntimeProvider";

const LIVE_POLL_MS = 2000;

type RuntimeEvent = Record<string, unknown>;

function sequenceOf(event: RuntimeEvent): number {
  const seq = Number(event.sequence);
  return Number.isFinite(seq) ? seq : 0;
}

function mergeUnique(base: RuntimeEvent[], incoming: RuntimeEvent[]): RuntimeEvent[] {
  const seen = new Set(base.map(sequenceOf));
  const added = incoming.filter((event) => !seen.has(sequenceOf(event)));
  if (added.length === 0) return base;
  // Backfill pages and live events can interleave; keep the thread sequence-ordered.
  return [...base, ...added].sort((a, b) => sequenceOf(a) - sequenceOf(b));
}

interface ChatPanelProps {
  taskId: string;
  agentId: string | null;
  taskDone: boolean;
  /** The AMA session this task is bound to (new ak runner). Present ⇒ AMA path. */
  amaSessionId?: string | null;
  /** The legacy daemon relay session (old, un-upgraded ak). Absent ama ⇒ tunnel. */
  relaySessionId?: string | null;
}

// Two clients can drive one board at once: a new ak (AMA runner) whose task is
// bound to an AMA session, and an old, un-upgraded ak whose legacy daemon relays
// over the tunnel. The chat renders each on its own path so neither blanks the
// other (see the design's Backward compatibility section).
export function ChatPanel({ taskId, agentId, taskDone, amaSessionId, relaySessionId }: ChatPanelProps) {
  if (!agentId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-content-tertiary">No agent assigned. Chat is available when an agent is working on this task.</p>
      </div>
    );
  }

  if (amaSessionId) {
    return <AmaSessionChat taskId={taskId} taskDone={taskDone} unavailableMessage="Session history is not available for this task." />;
  }

  if (relaySessionId) {
    return (
      <RelayRuntimeProvider sessionId={relaySessionId} taskDone={taskDone}>
        <ChatToolUIs />
        <AgentThread taskDone={taskDone} />
      </RelayRuntimeProvider>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <p className="text-sm text-content-tertiary text-center">Chat history is not available for this task.</p>
    </div>
  );
}

// The AMA path: the task's events live in the AMA control plane (the Session DO
// for cloud-loop runtimes, the runner store for self-hosted CLI runtimes), read
// back through AK's server as a paginated snapshot and live-tailed.
export function AmaSessionChat({
  taskId,
  sessionId,
  taskDone,
  unavailableMessage = "Session history is not available.",
}: {
  taskId?: string;
  sessionId?: string;
  taskDone: boolean;
  unavailableMessage?: string;
}) {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  // Events come entirely over the AMA browser WebSocket — never HTTP. On connect
  // the Session DO pushes the history (a backfill frame, paginated over the same
  // socket), then streams new events live. AK hands the SPA a token-bearing socket
  // URL; the browser connects directly to the session's DO socket.
  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    setPhase("loading");
    setEvents([]);

    const connect = async () => {
      try {
        const { url } = sessionId ? await api.sessions.sessionWs(sessionId) : await api.tasks.sessionWs(taskId!);
        if (!active) return;
        ws = new WebSocket(url);
        ws.onopen = () => {
          // Request history explicitly; stopped sessions may not push a backfill
          // frame until the client asks for one.
          ws?.send(JSON.stringify({ type: "backfill", order: "asc", limit: 200 }));
        };
        ws.onmessage = (event) => {
          try {
            const frame = JSON.parse(typeof event.data === "string" ? event.data : "");
            if (frame?.type === "backfill" && Array.isArray(frame.events)) {
              setEvents((prev) => mergeUnique(prev, frame.events as RuntimeEvent[]));
              setPhase("ready");
              // Pull older pages over the same socket until the history is whole.
              if (frame.hasMore && typeof frame.nextCursor === "number" && ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "backfill", order: "asc", limit: 200, cursor: frame.nextCursor }));
              }
            } else if (frame?.type === "event" && frame.event) {
              setEvents((prev) => mergeUnique(prev, [frame.event as RuntimeEvent]));
              setPhase("ready");
            }
          } catch {
            // ignore a malformed frame
          }
        };
        ws.onclose = () => {
          ws = null;
          // A finished task has no more live events; reconnect only while running.
          if (active && !taskDone) reconnect = setTimeout(connect, LIVE_POLL_MS);
        };
      } catch {
        if (active) {
          setPhase((prev) => (prev === "loading" ? "error" : prev));
          reconnect = setTimeout(connect, LIVE_POLL_MS);
        }
      }
    };
    void connect();
    return () => {
      active = false;
      if (reconnect) clearTimeout(reconnect);
      ws?.close();
    };
  }, [sessionId, taskId, taskDone]);

  if (phase === "loading") {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-sm text-content-tertiary text-center">Loading runtime history...</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-sm text-content-tertiary text-center">{unavailableMessage}</p>
      </div>
    );
  }

  return (
    <AmaRuntimeProvider events={events} taskDone={taskDone}>
      <ChatToolUIs />
      <AgentThread taskDone={taskDone} />
    </AmaRuntimeProvider>
  );
}
