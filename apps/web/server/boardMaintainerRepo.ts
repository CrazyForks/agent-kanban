import { type D1, newLongId, parseJsonFields } from "./db";

export interface BoardMaintainer {
  id: string;
  owner_id: string;
  board_id: string;
  repository_id: string | null;
  ak_agent_id: string;
  ama_agent_id: string;
  ama_environment_id: string;
  ama_schedule_id: string;
  name: string;
  prompt: string;
  interval_seconds: number;
  status: "active" | "paused" | "archived";
  last_run_at: string | null;
  last_ama_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardMaintainerRun {
  id: string;
  maintainer_id: string;
  board_id: string;
  ama_schedule_run_id: string;
  ama_session_id: string | null;
  scheduled_for: string;
  heartbeat_at: string;
  status: "claimed" | "session_created" | "failed";
  correlation_id: string;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateBoardMaintainerInput {
  boardId: string;
  repositoryId?: string | null;
  akAgentId: string;
  amaAgentId: string;
  amaEnvironmentId: string;
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

export interface AmaRunSnapshot {
  id: string;
  scheduledFor: string;
  heartbeatAt: string;
  status: "claimed" | "session_created" | "failed";
  sessionId: string | null;
  correlationId: string;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function parseRun<T extends BoardMaintainerRun>(row: T): T {
  return parseJsonFields(row, ["metadata"]);
}

export async function getOwnedBoard(db: D1, ownerId: string, boardId: string) {
  return await db.prepare("SELECT id, name FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).first<{ id: string; name: string }>();
}

export async function getOwnedRepository(db: D1, ownerId: string, repositoryId: string) {
  return await db
    .prepare("SELECT id, url FROM repositories WHERE id = ? AND owner_id = ?")
    .bind(repositoryId, ownerId)
    .first<{ id: string; url: string }>();
}

export async function createBoardMaintainer(db: D1, ownerId: string, input: CreateBoardMaintainerInput): Promise<BoardMaintainer> {
  const id = newLongId();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO board_maintainers (
        id, owner_id, board_id, repository_id, ak_agent_id, ama_agent_id, ama_environment_id, ama_schedule_id,
        name, prompt, interval_seconds, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      ownerId,
      input.boardId,
      input.repositoryId ?? null,
      input.akAgentId,
      input.amaAgentId,
      input.amaEnvironmentId,
      input.amaScheduleId,
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

export async function syncBoardMaintainerRuns(db: D1, maintainer: BoardMaintainer, runs: AmaRunSnapshot[]): Promise<BoardMaintainerRun[]> {
  const statements = runs.map((run) =>
    db
      .prepare(
        `INSERT INTO board_maintainer_runs (
          id, maintainer_id, board_id, ama_schedule_run_id, ama_session_id, scheduled_for, heartbeat_at,
          status, correlation_id, error_message, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ama_schedule_run_id) DO UPDATE SET
          ama_session_id = excluded.ama_session_id,
          status = excluded.status,
          error_message = excluded.error_message,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at`,
      )
      .bind(
        `bmr_${run.id}`,
        maintainer.id,
        maintainer.board_id,
        run.id,
        run.sessionId,
        run.scheduledFor,
        run.heartbeatAt,
        run.status,
        run.correlationId,
        run.errorMessage,
        JSON.stringify(run.metadata ?? {}),
        run.createdAt,
        run.updatedAt,
      ),
  );
  if (statements.length > 0) await db.batch(statements);

  const lastSession = runs.find((run) => run.sessionId)?.sessionId ?? maintainer.last_ama_session_id;
  const lastRunAt = runs[0]?.heartbeatAt ?? maintainer.last_run_at;
  await db
    .prepare("UPDATE board_maintainers SET last_run_at = ?, last_ama_session_id = ?, updated_at = ? WHERE id = ?")
    .bind(lastRunAt, lastSession, new Date().toISOString(), maintainer.id)
    .run();

  return await listBoardMaintainerRuns(db, maintainer.owner_id, maintainer.board_id, maintainer.id);
}

export async function listBoardMaintainerRuns(db: D1, ownerId: string, boardId: string, maintainerId: string): Promise<BoardMaintainerRun[]> {
  const rows = await db
    .prepare(
      `SELECT r.*
       FROM board_maintainer_runs r
       JOIN board_maintainers m ON m.id = r.maintainer_id
       WHERE m.owner_id = ? AND r.board_id = ? AND r.maintainer_id = ?
       ORDER BY r.created_at DESC`,
    )
    .bind(ownerId, boardId, maintainerId)
    .all<BoardMaintainerRun>();
  return rows.results.map(parseRun);
}
