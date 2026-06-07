import type { D1 } from "./db";

export interface RuntimeAgentMapping {
  ownerId: string;
  akAgentId: string;
  runtimeSource: string;
  runtimeAgentId: string;
  metadata: Record<string, unknown>;
}

export async function getRuntimeAgentMapping(
  db: D1,
  input: { ownerId: string; akAgentId: string; runtimeSource: string },
): Promise<RuntimeAgentMapping | null> {
  const row = await db
    .prepare(
      `SELECT owner_id, ak_agent_id, runtime_source, runtime_agent_id, metadata
       FROM runtime_agent_mappings
       WHERE owner_id = ? AND ak_agent_id = ? AND runtime_source = ?`,
    )
    .bind(input.ownerId, input.akAgentId, input.runtimeSource)
    .first<{ owner_id: string; ak_agent_id: string; runtime_source: string; runtime_agent_id: string; metadata: string }>();
  if (!row) return null;
  return {
    ownerId: row.owner_id,
    akAgentId: row.ak_agent_id,
    runtimeSource: row.runtime_source,
    runtimeAgentId: row.runtime_agent_id,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
  };
}

export async function upsertRuntimeAgentMapping(
  db: D1,
  input: { ownerId: string; akAgentId: string; runtimeSource: string; runtimeAgentId: string; metadata?: Record<string, unknown> },
): Promise<RuntimeAgentMapping> {
  const metadata = input.metadata ?? {};
  await db
    .prepare(
      `INSERT INTO runtime_agent_mappings (owner_id, ak_agent_id, runtime_source, runtime_agent_id, metadata)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, ak_agent_id, runtime_source) DO UPDATE SET
         runtime_agent_id = excluded.runtime_agent_id,
         metadata = excluded.metadata,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(input.ownerId, input.akAgentId, input.runtimeSource, input.runtimeAgentId, JSON.stringify(metadata))
    .run();
  return {
    ownerId: input.ownerId,
    akAgentId: input.akAgentId,
    runtimeSource: input.runtimeSource,
    runtimeAgentId: input.runtimeAgentId,
    metadata,
  };
}
