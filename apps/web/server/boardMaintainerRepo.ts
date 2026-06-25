import { type D1, newLongId } from "./db";

export interface BoardMaintainer {
  id: string;
  owner_id: string;
  board_id: string;
  agent_id: string;
  repository_id: string | null;
  ama_schedule_id: string;
  ama_http_trigger_id: string | null;
  ama_memory_store_id: string | null;
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
  repositoryId?: string | null;
  amaScheduleId: string;
  amaHttpTriggerId: string;
  amaMemoryStoreId: string;
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
        id, owner_id, board_id, agent_id, repository_id, ama_schedule_id, ama_http_trigger_id, ama_memory_store_id,
        name, prompt, interval_seconds, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      ownerId,
      input.boardId,
      input.agentId,
      input.repositoryId ?? null,
      input.amaScheduleId,
      input.amaHttpTriggerId,
      input.amaMemoryStoreId,
      input.name,
      input.prompt,
      input.intervalSeconds,
      input.status,
      now,
      now,
    )
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

export async function deleteBoardMaintainer(db: D1, ownerId: string, boardId: string, maintainerId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM board_maintainers WHERE owner_id = ? AND board_id = ? AND id = ?")
    .bind(ownerId, boardId, maintainerId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function listActiveBoardMaintainersForRepository(db: D1, installationId: number, fullName: string): Promise<BoardMaintainer[]> {
  const canonicalFullName = fullName.toLowerCase();
  const result = await db
    .prepare(
      `
      SELECT DISTINCT bm.*
      FROM board_maintainers bm
      JOIN repositories r ON r.id = bm.repository_id AND r.owner_id = bm.owner_id
      JOIN github_installations gi ON gi.owner_id = bm.owner_id AND gi.installation_id = ? AND gi.suspended_at IS NULL
      LEFT JOIN github_installation_repositories gir
        ON gir.installation_id = gi.installation_id AND gir.full_name = ?
      WHERE bm.status = 'active'
        AND bm.ama_http_trigger_id IS NOT NULL
        AND replace(replace(lower(r.url), 'https://github.com/', ''), 'http://github.com/', '') = ?
        AND (gi.repository_selection = 'all' OR gir.full_name IS NOT NULL)
      ORDER BY bm.created_at DESC
    `,
    )
    .bind(installationId, canonicalFullName, canonicalFullName)
    .all<BoardMaintainer>();
  return result.results;
}
