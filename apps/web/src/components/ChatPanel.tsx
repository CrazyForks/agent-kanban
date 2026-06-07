import { useQuery } from "@tanstack/react-query";
import { AgentThread, ChatToolUIs } from "@/components/chat";
import { api } from "../lib/api";
import { AmaRuntimeProvider } from "./RelayRuntimeProvider";

interface ChatPanelProps {
  taskId: string;
  agentId: string | null;
  taskDone: boolean;
}

export function ChatPanel({ taskId, agentId, taskDone }: ChatPanelProps) {
  const runtimeQuery = useQuery({
    queryKey: ["task-runtime", taskId],
    queryFn: () => api.tasks.runtime(taskId),
    enabled: !!agentId,
  });

  if (!agentId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-content-tertiary">No agent assigned. Chat is available when an agent is working on this task.</p>
      </div>
    );
  }

  if (runtimeQuery.isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-sm text-content-tertiary text-center">Loading runtime history...</p>
      </div>
    );
  }

  if (runtimeQuery.error) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-sm text-content-tertiary text-center">Session history is not available for this task.</p>
      </div>
    );
  }

  return (
    <AmaRuntimeProvider runtimeSnapshot={runtimeQuery.data} taskDone={taskDone}>
      <ChatToolUIs />
      <AgentThread taskDone={taskDone} />
    </AmaRuntimeProvider>
  );
}
