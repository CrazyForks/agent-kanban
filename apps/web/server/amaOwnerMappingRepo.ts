import type { D1 } from "./db";
import type { Env } from "./types";

export interface AmaOwnerMapping {
  ownerId: string;
  amaProjectId: string;
  externalTenantId: string;
  metadata: Record<string, unknown>;
}

export async function getAmaOwnerMapping(db: D1, ownerId: string): Promise<AmaOwnerMapping | null> {
  const row = await db
    .prepare("SELECT owner_id, ama_project_id, external_tenant_id, metadata FROM ama_owner_mappings WHERE owner_id = ?")
    .bind(ownerId)
    .first<{ owner_id: string; ama_project_id: string; external_tenant_id: string; metadata: string }>();
  if (!row) return null;
  return {
    ownerId: row.owner_id,
    amaProjectId: row.ama_project_id,
    externalTenantId: row.external_tenant_id,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
  };
}

export async function upsertAmaOwnerMapping(
  db: D1,
  input: { ownerId: string; amaProjectId: string; externalTenantId?: string; metadata?: Record<string, unknown> },
): Promise<AmaOwnerMapping> {
  const externalTenantId = input.externalTenantId ?? input.ownerId;
  const metadata = JSON.stringify(input.metadata ?? {});
  await db
    .prepare(
      `INSERT INTO ama_owner_mappings (owner_id, ama_project_id, external_tenant_id, metadata)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         ama_project_id = excluded.ama_project_id,
         external_tenant_id = excluded.external_tenant_id,
         metadata = excluded.metadata,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(input.ownerId, input.amaProjectId, externalTenantId, metadata)
    .run();
  return {
    ownerId: input.ownerId,
    amaProjectId: input.amaProjectId,
    externalTenantId,
    metadata: input.metadata ?? {},
  };
}

export async function resolveAmaProjectId(db: D1, env: Env, ownerId: string): Promise<string> {
  const mapping = await getAmaOwnerMapping(db, ownerId);
  if (mapping) return mapping.amaProjectId;
  if (env.AMA_PROJECT_ID) return env.AMA_PROJECT_ID;
  throw new Error(`AMA project mapping is missing for owner ${ownerId}`);
}

export async function resolveAmaExternalTenantId(db: D1, ownerId: string): Promise<string> {
  return (await getAmaOwnerMapping(db, ownerId))?.externalTenantId ?? ownerId;
}
