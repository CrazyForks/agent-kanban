import { createAmaEnvironment, createAmaProject, createAmaVault } from "./amaRuntime";
import type { D1 } from "./db";
import type { Env } from "./types";

export interface AmaOwnerIntegration {
  ownerId: string;
  amaProjectId: string;
  externalTenantId: string;
  sessionSecretVaultId: string | null;
  metadata: Record<string, unknown>;
}

type AmaOwnerIntegrationRow = {
  owner_id: string;
  ama_project_id: string;
  external_tenant_id: string;
  session_secret_vault_id: string | null;
  metadata: string;
};

export async function getAmaOwnerIntegration(db: D1, ownerId: string): Promise<AmaOwnerIntegration | null> {
  const row = await db
    .prepare("SELECT owner_id, ama_project_id, external_tenant_id, session_secret_vault_id, metadata FROM ama_owner_integrations WHERE owner_id = ?")
    .bind(ownerId)
    .first<AmaOwnerIntegrationRow>();
  return row ? parseIntegration(row) : null;
}

export async function upsertAmaOwnerIntegration(
  db: D1,
  input: {
    ownerId: string;
    amaProjectId: string;
    externalTenantId?: string;
    sessionSecretVaultId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<AmaOwnerIntegration> {
  const externalTenantId = input.externalTenantId ?? input.ownerId;
  const sessionSecretVaultId = input.sessionSecretVaultId ?? null;
  const metadata = input.metadata ?? {};
  await db
    .prepare(
      `INSERT INTO ama_owner_integrations (owner_id, ama_project_id, external_tenant_id, session_secret_vault_id, metadata)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         ama_project_id = excluded.ama_project_id,
         external_tenant_id = excluded.external_tenant_id,
         session_secret_vault_id = excluded.session_secret_vault_id,
         metadata = excluded.metadata,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(input.ownerId, input.amaProjectId, externalTenantId, sessionSecretVaultId, JSON.stringify(metadata))
    .run();
  return {
    ownerId: input.ownerId,
    amaProjectId: input.amaProjectId,
    externalTenantId,
    sessionSecretVaultId,
    metadata,
  };
}

export async function ensureAmaOwnerIntegration(db: D1, env: Env, ownerId: string): Promise<AmaOwnerIntegration> {
  const existing = await getAmaOwnerIntegration(db, ownerId);
  if (existing?.sessionSecretVaultId) return existing;

  const projectId = existing?.amaProjectId ?? (await createAmaProject(env, { name: `Workspace ${ownerId}` })).id;
  const vault = existing?.sessionSecretVaultId
    ? null
    : await createAmaVault(env, {
        projectId,
        name: "Session secrets",
        description: "Session credentials used by runtime sessions.",
        scope: "project",
        metadata: { purpose: "session-secrets" },
      });

  return await upsertAmaOwnerIntegration(db, {
    ownerId,
    amaProjectId: projectId,
    externalTenantId: existing?.externalTenantId ?? ownerId,
    sessionSecretVaultId: existing?.sessionSecretVaultId ?? vault?.id ?? null,
    metadata: existing?.metadata ?? {},
  });
}

export async function resolveAmaProjectId(db: D1, env: Env, ownerId: string): Promise<string> {
  return (await ensureAmaOwnerIntegration(db, env, ownerId)).amaProjectId;
}

// Read-only variant for GET paths: a read must never provision AMA resources.
export async function getAmaProjectId(db: D1, ownerId: string): Promise<string | null> {
  return (await getAmaOwnerIntegration(db, ownerId))?.amaProjectId ?? null;
}

export async function resolveAmaExternalTenantId(db: D1, env: Env, ownerId: string): Promise<string> {
  return (await ensureAmaOwnerIntegration(db, env, ownerId)).externalTenantId;
}

// One cloud AMA environment per owner: cloud sessions are sandbox-isolated by
// AMA, so a single environment serves every cloud-runtime task of the tenant.
export async function resolveAmaCloudEnvironmentId(db: D1, env: Env, ownerId: string): Promise<string> {
  const integration = await ensureAmaOwnerIntegration(db, env, ownerId);
  const existing = integration.metadata.cloudEnvironmentId;
  if (typeof existing === "string" && existing) return existing;

  const environment = await createAmaEnvironment(env, {
    projectId: integration.amaProjectId,
    name: "Cloud sandbox",
    description: `Cloud execution environment for AK owner ${ownerId}.`,
    hostingMode: "cloud",
    metadata: { ownerId },
  });
  await upsertAmaOwnerIntegration(db, {
    ownerId,
    amaProjectId: integration.amaProjectId,
    externalTenantId: integration.externalTenantId,
    sessionSecretVaultId: integration.sessionSecretVaultId,
    metadata: { ...integration.metadata, cloudEnvironmentId: environment.id },
  });
  return environment.id;
}

export async function resolveAmaSessionSecretVaultId(db: D1, env: Env, ownerId: string): Promise<string> {
  const binding = await ensureAmaOwnerIntegration(db, env, ownerId);
  if (!binding.sessionSecretVaultId) {
    throw new Error(`AMA session secret vault is missing for owner ${ownerId}`);
  }
  return binding.sessionSecretVaultId;
}

function parseIntegration(row: AmaOwnerIntegrationRow): AmaOwnerIntegration {
  return {
    ownerId: row.owner_id,
    amaProjectId: row.ama_project_id,
    externalTenantId: row.external_tenant_id,
    sessionSecretVaultId: row.session_secret_vault_id,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
  };
}
