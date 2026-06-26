import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MaintainerDetailPage } from "../apps/web/src/routes/MaintainerDetailPage";

vi.mock("../apps/web/src/components/Header", () => ({
  Header: () => React.createElement("header", { "data-testid": "header" }),
}));

vi.mock("../apps/web/src/components/ChatPanel", () => ({
  AmaSessionChat: ({ sessionId }: { sessionId: string }) => React.createElement("div", { "data-testid": "maintainer-session-chat" }, sessionId),
}));

const useBoard = vi.fn();
const useBoardMaintainer = vi.fn();
const useBoardMaintainerRuns = vi.fn();
const useBoardMaintainerSessions = vi.fn();
const useBoardMaintainerMemories = vi.fn();

vi.mock("../apps/web/src/hooks/useBoard", () => ({
  useBoard: (...args: unknown[]) => useBoard(...args),
  useBoardMaintainer: (...args: unknown[]) => useBoardMaintainer(...args),
  useBoardMaintainerRuns: (...args: unknown[]) => useBoardMaintainerRuns(...args),
  useBoardMaintainerSessions: (...args: unknown[]) => useBoardMaintainerSessions(...args),
  useBoardMaintainerMemories: (...args: unknown[]) => useBoardMaintainerMemories(...args),
}));

function renderMaintainerDetail() {
  render(
    <MemoryRouter initialEntries={["/boards/board-1/maintainers/maintainer-1"]}>
      <Routes>
        <Route path="/boards/:boardId/maintainers/:maintainerId" element={<MaintainerDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MaintainerDetailPage", () => {
  beforeEach(() => {
    useBoard.mockReturnValue({
      loading: false,
      board: { id: "board-1", name: "Demo board" },
    });
    useBoardMaintainer.mockReturnValue({
      loading: false,
      refresh: vi.fn(),
      maintainer: {
        id: "maintainer-1",
        name: "Daily maintainer",
        prompt: "Inspect open work.",
        status: "active",
        agent_id: "agent-1",
        interval_seconds: 3600,
        last_run_at: "2026-06-08T12:10:00.000Z",
        last_session_id: "session_1",
        last_error_message: null,
      },
    });
    useBoardMaintainerRuns.mockReturnValue({
      loading: false,
      refresh: vi.fn(),
      runs: [
        {
          id: "run_1",
          scheduled_for: "2026-06-08T12:00:00.000Z",
          heartbeat_at: "2026-06-08T12:00:03.000Z",
          triggered_at: "2026-06-08T12:00:00.000Z",
          status: "completed",
          session_id: "session_1",
          error_message: null,
          metadata: { attempt: 1 },
        },
        {
          id: "run_duplicate",
          scheduled_for: null,
          heartbeat_at: null,
          triggered_at: "2026-06-08T12:05:00.000Z",
          status: "dispatched",
          session_id: "session_1",
          error_message: null,
          metadata: {
            sessionMetadata: {
              github: {
                event: "issues",
                action: "opened",
                repository: "saltbo/slink",
                repository_url: "https://github.com/saltbo/slink",
                subject_type: "issue",
                subject_number: 42,
                subject_title: "Webhook issue",
                subject_url: "https://github.com/saltbo/slink/issues/42",
              },
            },
          },
        },
        {
          id: "run_failed_without_session",
          scheduled_for: null,
          heartbeat_at: null,
          triggered_at: "2026-06-08T12:06:00.000Z",
          status: "failed",
          session_id: null,
          error_message: "No session created",
          metadata: { event: "issues" },
        },
      ],
    });
    useBoardMaintainerSessions.mockReturnValue({
      loading: false,
      refresh: vi.fn(),
      sessions: [
        {
          id: "session_1",
          state: "idle",
          agentId: "ama_agent_1",
          title: "Daily maintainer",
          metadata: {
            labels: { maintainerId: "maintainer-1" },
            github: {
              event: "issues",
              action: "opened",
              repository: "saltbo/slink",
              repository_url: "https://github.com/saltbo/slink",
              subject_type: "issue",
              subject_number: 42,
              subject_title: "Webhook issue",
              subject_url: "https://github.com/saltbo/slink/issues/42",
            },
          },
          createdAt: "2026-06-08T12:00:00.000Z",
          updatedAt: "2026-06-08T12:08:00.000Z",
        },
      ],
    });
    useBoardMaintainerMemories.mockReturnValue({
      loading: false,
      error: null,
      refresh: vi.fn(),
      memories: [
        {
          id: "memory_heartbeat",
          path: "HEARTBEAT.md",
          content: "## Checklist\n\n- Review open issues",
          metadata: {},
          created_at: "2026-06-08T11:00:00.000Z",
          updated_at: "2026-06-08T11:30:00.000Z",
        },
        {
          id: "memory_notes",
          path: "notes/2026-06-08.md",
          content: "Follow up later.",
          metadata: {},
          created_at: "2026-06-08T11:10:00.000Z",
          updated_at: "2026-06-08T11:40:00.000Z",
        },
      ],
    });
  });

  it("renders maintainer sessions and memory file contents", () => {
    renderMaintainerDetail();

    expect(screen.getByRole("heading", { name: "Daily maintainer" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Sessions\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /session_1/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /saltbo\/slink Issue #42/ })).toHaveAttribute("href", "https://github.com/saltbo/slink/issues/42");
    expect(screen.queryByText("run_duplicate")).not.toBeInTheDocument();
    expect(screen.queryByText("run_failed_without_session")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    expect(screen.getByText("issues.opened")).toBeInTheDocument();
    expect(screen.getByText("dispatched")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Memory/ }));

    expect(screen.getAllByText("HEARTBEAT.md")[0]).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Checklist" })).toBeInTheDocument();
    expect(screen.getByText("Review open issues").closest("li")).toBeInTheDocument();

    fireEvent.click(screen.getByText("notes/2026-06-08.md"));
    expect(screen.getByText("Follow up later.")).toBeInTheDocument();
  });

  it("opens a maintainer session chat drawer from the sessions table", () => {
    renderMaintainerDetail();

    fireEvent.click(screen.getByRole("button", { name: /session_1/ }));

    expect(screen.getByTestId("maintainer-session-chat")).toHaveTextContent("session_1");
  });
});
