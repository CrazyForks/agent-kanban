import { createAmaEnvironment, createAmaProject, createAmaVault, readAmaProject } from "./amaRuntime";
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

// True when the AK user has linked their own AMA account (a BetterAuth
// generic-OIDC "ama" account). AMA/cloud-scheduling features gate on this; a
// standalone user who never connected AMA simply has no row.
export async function hasAmaAccount(db: D1, ownerId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM account WHERE userId = ? AND providerId = 'ama' LIMIT 1")
    .bind(ownerId)
    .first<{ present: number }>();
  return row !== null;
}

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
  // Validate the stored project still exists: AMA resources can be deleted out
  // of band (e.g. a control-plane data reset), leaving our ids dangling. A
  // missing project means its vault and cloud environment are gone too, so
  // re-provision the whole integration rather than dispatch against ghosts.
  const projectAlive = existing?.amaProjectId ? (await readAmaProject(env, ownerId, existing.amaProjectId)) !== null : false;
  if (existing?.sessionSecretVaultId && projectAlive) return existing;

  const projectId = projectAlive ? existing!.amaProjectId : (await createAmaProject(env, ownerId, { name: `Workspace ${ownerId}` })).id;
  const reuseVault = Boolean(projectAlive && existing?.sessionSecretVaultId);
  const vault = reuseVault
    ? null
    : await createAmaVault(env, ownerId, {
        projectId,
        name: "Session secrets",
        description: "Session credentials used by runtime sessions.",
        scope: "project",
      });

  return await upsertAmaOwnerIntegration(db, {
    ownerId,
    amaProjectId: projectId,
    externalTenantId: existing?.externalTenantId ?? ownerId,
    sessionSecretVaultId: reuseVault ? existing!.sessionSecretVaultId : (vault?.id ?? null),
    // A re-provisioned project's cloud sandboxes are gone; drop stale metadata.
    metadata: projectAlive ? (existing?.metadata ?? {}) : {},
  });
}

export async function resolveAmaProjectId(db: D1, env: Env, ownerId: string): Promise<string> {
  return (await ensureAmaOwnerIntegration(db, env, ownerId)).amaProjectId;
}

// Read-only variant for GET paths: a read must never provision AMA resources.
export async function getAmaProjectId(db: D1, ownerId: string): Promise<string | null> {
  return (await getAmaOwnerIntegration(db, ownerId))?.amaProjectId ?? null;
}

// Read-only project id for dispatch: the project is provisioned eagerly when
// the owner connects AMA, so dispatch must find it rather than create it. A
// missing integration means the owner never connected (or provisioning never
// ran) — fail loudly rather than silently provisioning mid-dispatch.
export async function requireAmaProjectId(db: D1, ownerId: string): Promise<string> {
  const projectId = await getAmaProjectId(db, ownerId);
  if (!projectId) {
    throw new Error(`No AMA project for owner ${ownerId}; connect AMA before dispatching tasks`);
  }
  return projectId;
}

export async function resolveAmaExternalTenantId(db: D1, env: Env, ownerId: string): Promise<string> {
  return (await ensureAmaOwnerIntegration(db, env, ownerId)).externalTenantId;
}

// Creates a fresh cloud-sandbox AMA environment for a cloud-sandbox machine.
// Each cloud sandbox is its own environment (AMA scales sandboxes per session),
// so this always provisions a new one rather than reusing a per-owner singleton.
export async function createAmaCloudSandboxEnvironment(
  db: D1,
  env: Env,
  ownerId: string,
  name: string,
): Promise<{ projectId: string; environmentId: string }> {
  const integration = await ensureAmaOwnerIntegration(db, env, ownerId);
  const environment = await createAmaEnvironment(env, ownerId, {
    projectId: integration.amaProjectId,
    name,
    description: `Cloud sandbox for AK owner ${ownerId}.`,
    hostingMode: "cloud",
    metadata: { ownerId },
  });
  return { projectId: integration.amaProjectId, environmentId: environment.id };
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
