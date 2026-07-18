import type { D1 } from "./db";
import { TASK_RUNTIME_SOURCE_ANNOTATION, type TaskRuntimeSource } from "./runtimeBinding";

export interface PendingTaskRuntimeBinding {
  id: string;
  ownerId: string;
}

export async function listPendingTaskRuntimeBindings(db: D1): Promise<PendingTaskRuntimeBinding[]> {
  const rows = await db
    .prepare(`
      SELECT t.id, b.owner_id FROM tasks t
      JOIN boards b ON t.board_id = b.id
      WHERE t.status = 'todo' AND t.assigned_to IS NOT NULL
        AND json_extract(t.metadata, '$.annotations."ama.dispatch.result"') IS NULL
    `)
    .all<{ id: string; owner_id: string }>();
  return rows.results.map((row) => ({ id: row.id, ownerId: row.owner_id }));
}

export async function compareAndSetTaskRuntimeSource(
  db: D1,
  taskId: string,
  current: TaskRuntimeSource | null,
  next: TaskRuntimeSource,
): Promise<boolean> {
  const sourceGuard = current
    ? `json_extract(metadata, '$.annotations."${TASK_RUNTIME_SOURCE_ANNOTATION}"') = ?`
    : `json_extract(metadata, '$.annotations."${TASK_RUNTIME_SOURCE_ANNOTATION}"') IS NULL`;
  const binds = current ? [next, taskId, current] : [next, taskId];
  const result = await db
    .prepare(`
      UPDATE tasks SET metadata = json_set(
        json_set(COALESCE(metadata, '{}'), '$.annotations', json(COALESCE(json_extract(metadata, '$.annotations'), '{}'))),
        '$.annotations."${TASK_RUNTIME_SOURCE_ANNOTATION}"', ?
      )
      WHERE id = ?
        AND status = 'todo'
        AND assigned_to IS NOT NULL
        AND json_extract(metadata, '$.annotations."ama.dispatch.result"') IS NULL
        AND json_extract(metadata, '$.annotations."ama.sessionId"') IS NULL
        AND json_extract(metadata, '$.annotations."agentSessionId"') IS NULL
        AND ${sourceGuard}
    `)
    .bind(...binds)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function persistInferredAmaTaskRuntimeSource(db: D1, taskId: string): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE tasks SET metadata = json_set(
        json_set(COALESCE(metadata, '{}'), '$.annotations', json(COALESCE(json_extract(metadata, '$.annotations'), '{}'))),
        '$.annotations."${TASK_RUNTIME_SOURCE_ANNOTATION}"', 'ama'
      )
      WHERE id = ?
        AND status = 'todo'
        AND assigned_to IS NOT NULL
        AND json_extract(metadata, '$.annotations."${TASK_RUNTIME_SOURCE_ANNOTATION}"') IS NULL
        AND (
          json_type(metadata, '$.annotations."ama.sessionId"') = 'text'
          OR json_type(metadata, '$.annotations."agentSessionId"') = 'text'
        )
    `)
    .bind(taskId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
