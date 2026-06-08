import { type D1, newLongId } from "./db";

export interface BoardMaintainer {
  id: string;
  owner_id: string;
  board_id: string;
  agent_id: string;
  ama_schedule_id: string;
  name: string;
  prompt: string;
  interval_seconds: number;
  status: "active" | "paused" | "archived";
  last_run_at: string | null;
  last_ama_session_id: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBoardMaintainerInput {
  boardId: string;
  agentId: string;
  amaScheduleId: string;
  name: string;
  prompt: string;
  intervalSeconds: number;
  status: "active" | "paused";
}

export interface UpdateBoardMaintainerInput {
  name?: string;
  prompt?: string;
  intervalSeconds?: number;
  status?: "active" | "paused" | "archived";
}

export async function getOwnedBoard(db: D1, ownerId: string, boardId: string) {
  return await db.prepare("SELECT id, name FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).first<{ id: string; name: string }>();
}

export async function createBoardMaintainer(db: D1, ownerId: string, input: CreateBoardMaintainerInput): Promise<BoardMaintainer> {
  const id = newLongId();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO board_maintainers (
        id, owner_id, board_id, agent_id, ama_schedule_id,
        name, prompt, interval_seconds, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, ownerId, input.boardId, input.agentId, input.amaScheduleId, input.name, input.prompt, input.intervalSeconds, input.status, now, now)
    .run();
  const maintainer = await getBoardMaintainer(db, ownerId, input.boardId, id);
  if (!maintainer) throw new Error("Board maintainer was not persisted");
  return maintainer;
}

export async function listBoardMaintainers(db: D1, ownerId: string, boardId: string): Promise<BoardMaintainer[]> {
  const rows = await db
    .prepare("SELECT * FROM board_maintainers WHERE owner_id = ? AND board_id = ? AND status != 'archived' ORDER BY created_at DESC")
    .bind(ownerId, boardId)
    .all<BoardMaintainer>();
  return rows.results;
}

export async function getBoardMaintainer(db: D1, ownerId: string, boardId: string, maintainerId: string): Promise<BoardMaintainer | null> {
  return await db
    .prepare("SELECT * FROM board_maintainers WHERE owner_id = ? AND board_id = ? AND id = ?")
    .bind(ownerId, boardId, maintainerId)
    .first<BoardMaintainer>();
}

export async function updateBoardMaintainer(
  db: D1,
  ownerId: string,
  boardId: string,
  maintainerId: string,
  updates: UpdateBoardMaintainerInput,
): Promise<BoardMaintainer | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    sets.push("name = ?");
    values.push(updates.name);
  }
  if (updates.prompt !== undefined) {
    sets.push("prompt = ?");
    values.push(updates.prompt);
  }
  if (updates.intervalSeconds !== undefined) {
    sets.push("interval_seconds = ?");
    values.push(updates.intervalSeconds);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }
  if (sets.length === 0) return await getBoardMaintainer(db, ownerId, boardId, maintainerId);
  sets.push("updated_at = ?");
  values.push(new Date().toISOString(), ownerId, boardId, maintainerId);
  await db
    .prepare(`UPDATE board_maintainers SET ${sets.join(", ")} WHERE owner_id = ? AND board_id = ? AND id = ?`)
    .bind(...values)
    .run();
  return await getBoardMaintainer(db, ownerId, boardId, maintainerId);
}
