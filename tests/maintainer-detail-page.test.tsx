import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MaintainerDetailPage } from "../apps/web/src/routes/MaintainerDetailPage";

vi.mock("../apps/web/src/components/Header", () => ({
  Header: () => React.createElement("header", { "data-testid": "header" }),
}));

const useBoard = vi.fn();
const useBoardMaintainer = vi.fn();
const useBoardMaintainerRuns = vi.fn();
const useBoardMaintainerMemories = vi.fn();

vi.mock("../apps/web/src/hooks/useBoard", () => ({
  useBoard: (...args: unknown[]) => useBoard(...args),
  useBoardMaintainer: (...args: unknown[]) => useBoardMaintainer(...args),
  useBoardMaintainerRuns: (...args: unknown[]) => useBoardMaintainerRuns(...args),
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
    expect(screen.getByText("run_1")).toBeInTheDocument();
    expect(screen.getAllByText("completed")[0]).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Memory/ }));

    expect(screen.getAllByText("HEARTBEAT.md")[0]).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Checklist" })).toBeInTheDocument();
    expect(screen.getByText("Review open issues").closest("li")).toBeInTheDocument();

    fireEvent.click(screen.getByText("notes/2026-06-08.md"));
    expect(screen.getByText("Follow up later.")).toBeInTheDocument();
  });
});
