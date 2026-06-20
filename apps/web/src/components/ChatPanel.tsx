import { useCallback, useEffect, useRef, useState } from "react";
import { AgentThread, ChatToolUIs } from "@/components/chat";
import { api } from "../lib/api";
import { AmaRuntimeProvider, RelayRuntimeProvider } from "./RelayRuntimeProvider";

const PAGE_SIZE = 50;
const LIVE_POLL_MS = 2000;

type RuntimeEvent = Record<string, unknown>;

function sequenceOf(event: RuntimeEvent): number {
  const seq = Number(event.sequence);
  return Number.isFinite(seq) ? seq : 0;
}

function mergeUnique(base: RuntimeEvent[], incoming: RuntimeEvent[], side: "head" | "tail"): RuntimeEvent[] {
  const seen = new Set(base.map(sequenceOf));
  const added = incoming.filter((event) => !seen.has(sequenceOf(event)));
  if (added.length === 0) return base;
  return side === "head" ? [...added, ...base] : [...base, ...added];
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
    return <AmaSessionChat taskId={taskId} taskDone={taskDone} />;
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
function AmaSessionChat({ taskId, taskDone }: { taskId: string; taskDone: boolean }) {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [session, setSession] = useState<RuntimeEvent | undefined>(undefined);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  // Refs so the polling/loadOlder closures always read the current bounds.
  const earliestSeqRef = useRef<number | undefined>(undefined);
  const latestSeqRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    earliestSeqRef.current = events.length ? sequenceOf(events[0]) : undefined;
    latestSeqRef.current = events.length ? sequenceOf(events[events.length - 1]) : undefined;
  }, [events]);

  // Initial load: the most recent page (descending), displayed oldest -> newest.
  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setEvents([]);
    setHasOlder(false);
    api.tasks
      .runtime(taskId, { order: "desc", limit: PAGE_SIZE })
      .then((data) => {
        if (cancelled) return;
        setEvents([...(data?.events ?? [])].reverse());
        setSession(data?.session ?? undefined);
        setHasOlder(Boolean(data?.pagination?.hasMore));
        setPhase("ready");
      })
      .catch(() => {
        if (!cancelled) setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // Live tail: events are pushed over the AMA browser WebSocket — no poll loop.
  // AK hands the SPA a token-bearing socket URL and the browser connects directly
  // to the session's DO socket. A finished task has no more live events, so we do
  // one catch-up read instead of holding a socket open.
  useEffect(() => {
    if (phase !== "ready") return;
    let active = true;

    if (taskDone) {
      void (async () => {
        try {
          const data = await api.tasks.runtime(taskId, { order: "asc", cursor: latestSeqRef.current, limit: PAGE_SIZE });
          if (!active) return;
          setSession(data?.session ?? undefined);
          if (data?.events?.length) setEvents((prev) => mergeUnique(prev, data.events, "tail"));
        } catch {
          // transient
        }
      })();
      return () => {
        active = false;
      };
    }

    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    const connect = async () => {
      try {
        const { url } = await api.tasks.runtimeSocket(taskId);
        if (!active) return;
        ws = new WebSocket(url);
        ws.onmessage = (event) => {
          try {
            const frame = JSON.parse(typeof event.data === "string" ? event.data : "");
            if (frame?.type === "event" && frame.event) {
              setEvents((prev) => mergeUnique(prev, [frame.event as RuntimeEvent], "tail"));
            }
          } catch {
            // ignore a malformed frame
          }
        };
        ws.onclose = () => {
          ws = null;
          if (active) reconnect = setTimeout(connect, LIVE_POLL_MS);
        };
      } catch {
        if (active) reconnect = setTimeout(connect, LIVE_POLL_MS);
      }
    };
    void connect();
    return () => {
      active = false;
      if (reconnect) clearTimeout(reconnect);
      ws?.close();
    };
  }, [phase, taskDone, taskId]);

  const loadOlder = useCallback(async () => {
    const cursor = earliestSeqRef.current;
    if (loadingOlder || !hasOlder || cursor === undefined) return;
    setLoadingOlder(true);
    try {
      const data = await api.tasks.runtime(taskId, { order: "desc", cursor, limit: PAGE_SIZE });
      const older: RuntimeEvent[] = [...(data?.events ?? [])].reverse();
      if (older.length) setEvents((prev) => mergeUnique(prev, older, "head"));
      setHasOlder(Boolean(data?.pagination?.hasMore));
    } catch {
      // keep hasOlder so the user can retry by scrolling again
    } finally {
      setLoadingOlder(false);
    }
  }, [taskId, hasOlder, loadingOlder]);

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
        <p className="text-sm text-content-tertiary text-center">Session history is not available for this task.</p>
      </div>
    );
  }

  return (
    <AmaRuntimeProvider runtimeSnapshot={{ session, events }} taskDone={taskDone}>
      <ChatToolUIs />
      <AgentThread taskDone={taskDone} onLoadOlder={hasOlder ? loadOlder : undefined} loadingOlder={loadingOlder} />
    </AmaRuntimeProvider>
  );
}
