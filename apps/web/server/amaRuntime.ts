import { createAmaClient as createSdkClient, type Runtime, type UpdateTriggerRequest } from "@any-managed-agents/sdk";
import { createAuth } from "./betterAuth";
import type { Env } from "./types";

const amaAccessTokenRequests = new Map<string, Promise<string>>();

export type AmaResourceRef = Record<string, unknown>;
export interface AmaRuntimeSecretEnvRef {
  name: string;
  credentialId: string;
  versionId?: string | null;
}

export interface AmaTaskSessionInput {
  projectId: string;
  agentId: string;
  environmentId: string;
  runtime: string;
  title: string;
  initialPrompt?: string | null;
  resourceRefs?: AmaResourceRef[];
  runtimeEnv?: Record<string, string>;
  runtimeSecretEnv?: AmaRuntimeSecretEnvRef[];
}

export interface AmaAgentInput {
  projectId: string;
  name: string;
  description?: string | null;
  instructions?: string | null;
  provider: string;
  model?: string | null;
  role?: string | null;
  skills?: string[] | null;
  subagents?: Record<string, unknown>[] | null;
  capabilityTags?: string[] | null;
  handoffPolicy?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  memoryPolicy?: Record<string, unknown>;
}

export interface AmaAgent {
  id: string;
  projectId: string;
  name: string;
  provider: string;
  model: string | null;
}

export interface AmaEnvironment {
  id: string;
}

export interface AmaProviderModelProfile {
  provider: string;
  model: string | null;
  runtime: string;
}

export interface AmaSessionDispatch {
  projectId: string;
  agentId: string;
  environmentId: string;
  sessionId: string;
  status: string;
  statusReason: string | null;
}

export interface AmaSessionSecretInput {
  projectId: string;
  vaultId: string;
  name: string;
  secretValue: string;
  metadata?: Record<string, unknown>;
}

export interface AmaSessionSecret {
  credentialId: string;
  activeVersionId: string;
}

export interface AmaScheduledTriggerInput {
  projectId: string;
  agentId: string;
  // Omit to leave the trigger unpinned: AMA resolves a runner-capable
  // environment for the runtime at each dispatch instead of at creation.
  environmentId?: string | null;
  runtime: string;
  name: string;
  promptTemplate: string;
  intervalSeconds: number;
  status?: "active" | "paused";
  resourceRefs?: AmaResourceRef[];
  runtimeEnv?: Record<string, string>;
  runtimeSecretEnv?: AmaRuntimeSecretEnvRef[];
}

export interface AmaScheduledTriggerUpdate {
  agentId?: string;
  environmentId?: string | null;
  runtime?: string;
  name?: string;
  promptTemplate?: string;
  intervalSeconds?: number;
  status?: "active" | "paused";
}

export interface AmaScheduledTrigger {
  id: string;
  agentId: string;
  environmentId: string | null;
  name: string;
  promptTemplate: string;
  schedule: { intervalSeconds: number; windowSeconds?: number };
  status: "active" | "paused" | "archived";
  lastDispatchedAt: string | null;
  lastRunId: string | null;
}

export interface AmaScheduledTriggerRun {
  id: string;
  projectId: string;
  triggerId: string;
  scheduledFor: string;
  heartbeatAt: string;
  status: string;
  sessionId: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AmaRuntimeCommandResult {
  accepted: boolean;
}

export interface AmaListResponse<T> {
  data: T[];
  pagination?: Record<string, unknown>;
}

export interface AmaRuntimeUsageWindow {
  label: string;
  utilization: number;
  resetsAt: string;
}
export interface AmaRuntimeUsage {
  runtime: string;
  windows: AmaRuntimeUsageWindow[];
}
export interface AmaRunner {
  id: string;
  environmentId: string | null;
  status: string;
  capabilities: string[];
  currentLoad: number;
  maxConcurrent: number;
  lastHeartbeatAt: string | null;
  runtimeUsage?: AmaRuntimeUsage[];
}

export interface AmaFederatedTenantInput {
  projectId: string;
  issuer: string;
  externalTenantId: string;
  environmentId?: string | null;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

// A runner federated tenant must be allowed to poll for and claim work; these
// are the capabilities AMA's self-hosted runner protocol checks.
const RUNNER_FEDERATION_CAPABILITIES = ["session:poll", "session:claim"];

export interface AmaProject {
  id: string;
  name: string;
}

export interface AmaVaultInput {
  projectId: string;
  name: string;
  description?: string;
  scope: "project" | "organization";
  metadata?: Record<string, unknown>;
}

export interface AmaVault {
  id: string;
}

export interface AmaEnvironmentInput {
  projectId: string;
  name: string;
  description?: string;
  hostingMode: "self_hosted" | "cloud";
  metadata?: Record<string, unknown>;
}

// AMA's model catalog is a single global vendor catalog (auto-discovered from
// models.dev); a provider row's id IS its vendor slug, and an agent must pin a
// real catalog vendor as its providerId. For cloud (ama) the vendor is encoded
// in the model id, so it is derived per dispatch. For self-hosted CLIs the host
// owns the model universe (the runner's declared capabilities gate it), so the
// runtime's natural vendor is used as the pinned provider.
const RUNTIME_PROVIDER_PROFILES: Record<string, { providerSlug: string; cloud?: boolean }> = {
  "claude-code": { providerSlug: "anthropic" },
  codex: { providerSlug: "openai" },
  // Copilot's host runner declares its own models via runner capabilities; the
  // pinned slug is AMA agent metadata for a runner-gated runtime, not a catalog
  // lookup key, so any real vendor satisfies it.
  copilot: { providerSlug: "openai" },
  ama: { providerSlug: "", cloud: true },
};

const WORKERS_AI_NATIVE_PREFIX = "@cf/";

// Provider identity in AMA's global catalog is the vendor slug, encoded in the
// model id: `@cf/{vendor}/{model}` (Workers AI native) or `{vendor}/{model}`
// (AI-gateway). Mirrors AMA's server/domain/model-catalog vendorFromModelId.
export function vendorFromModelId(modelId: string): string {
  const path = modelId.startsWith(WORKERS_AI_NATIVE_PREFIX) ? modelId.slice(WORKERS_AI_NATIVE_PREFIX.length) : modelId;
  const segments = path.split("/");
  const [first] = segments;
  return segments.length >= 2 && first ? first : "unknown";
}

// AMA is "configured" for this AK instance when the AMA origin and the OAuth
// client used to register the OIDC provider are present. Per-call authorization
// is the logged-in user's own linked AMA account (resolved at request time).
function hasAmaOAuthClient(env: Env): boolean {
  return Boolean(env.AMA_OAUTH_TOKEN_URL && env.AMA_OAUTH_CLIENT_ID && env.AMA_OAUTH_CLIENT_SECRET);
}

export function isAmaRuntimeConfigured(env: Env): boolean {
  return Boolean(env.AMA_ORIGIN && hasAmaOAuthClient(env));
}

export function isAmaTaskDispatchConfigured(env: Env): boolean {
  return isAmaRuntimeConfigured(env);
}

export async function createAmaTaskSession(env: Env, ownerId: string, input: AmaTaskSessionInput): Promise<AmaSessionDispatch> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const session = await withAmaErrorDetails("create session", () =>
    client.sessions.create({
      agentId: input.agentId,
      environmentId: input.environmentId,
      runtime: input.runtime as Runtime,
      title: input.title,
      resourceRefs: input.resourceRefs ?? [],
      ...(input.runtimeEnv ? { env: input.runtimeEnv } : {}),
      ...(input.runtimeSecretEnv ? { secretEnv: toAmaSecretEnv(input.runtimeSecretEnv) } : {}),
      ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
    }),
  );

  return {
    projectId: input.projectId,
    agentId: session.agentId,
    environmentId: session.environmentId ?? input.environmentId,
    sessionId: session.id,
    status: session.state,
    statusReason: session.stateReason,
  };
}

// The /api/v1 secret-env contract takes a CredentialRef ({ credentialId,
// versionId? }) per entry rather than a bare version id.
function toAmaSecretEnv(entries: AmaRuntimeSecretEnvRef[]): { name: string; credentialRef: { credentialId: string; versionId?: string } }[] {
  return entries.map((entry) => ({
    name: entry.name,
    credentialRef: { credentialId: entry.credentialId, ...(entry.versionId ? { versionId: entry.versionId } : {}) },
  }));
}

export async function createAmaAgent(env: Env, ownerId: string, input: AmaAgentInput): Promise<AmaAgent> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const agent = await withAmaErrorDetails("create runtime agent", () =>
    client.agents.create({
      name: input.name,
      description: input.description ?? null,
      instructions: input.instructions ?? null,
      ...(input.provider ? { providerId: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.role ? { role: input.role } : {}),
      skills: input.skills ?? [],
      subagents: input.subagents ?? [],
      capabilityTags: input.capabilityTags ?? [],
      handoffPolicy: input.handoffPolicy ?? {},
      metadata: input.metadata ?? {},
      memoryPolicy: input.memoryPolicy ?? { enabled: false },
    }),
  );
  return {
    id: agent.id,
    projectId: agent.projectId,
    name: agent.name,
    provider: agent.providerId ?? input.provider,
    model: agent.model,
  };
}

export async function createAmaProject(env: Env, ownerId: string, input: { name: string }): Promise<AmaProject> {
  const client = await createAmaClient(env, ownerId);
  const project = await withAmaErrorDetails("create project", () => client.projects.create({ name: input.name }));
  return { id: project.id, name: project.name };
}

export async function createAmaVault(env: Env, ownerId: string, input: AmaVaultInput): Promise<AmaVault> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const vault = await withAmaErrorDetails("create vault", () =>
    client.vaults.create({
      name: input.name,
      description: input.description,
      scope: input.scope,
      metadata: input.metadata ?? {},
    }),
  );
  return { id: vault.id };
}

export async function createAmaEnvironment(env: Env, ownerId: string, input: AmaEnvironmentInput): Promise<AmaEnvironment> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const environment = await withAmaErrorDetails("create environment", () =>
    client.environments.create({
      name: input.name,
      description: input.description,
      hostingMode: input.hostingMode,
      metadata: input.metadata ?? {},
    }),
  );
  return { id: environment.id };
}

async function withAmaErrorDetails<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? ` HTTP ${(error as { status: number }).status}` : "";
    const responseText =
      typeof (error as { responseText?: unknown }).responseText === "string" ? `: ${(error as { responseText: string }).responseText}` : "";
    throw new Error(`AMA ${operation} failed${status}${responseText}`);
  }
}

export async function readAmaAgent(env: Env, ownerId: string, projectId: string, agentId: string): Promise<AmaAgent | null> {
  const client = await createAmaClient(env, ownerId, projectId);
  try {
    const agent = await client.agents.get(agentId);
    return {
      id: agent.id,
      projectId: agent.projectId,
      name: agent.name,
      provider: agent.providerId ?? "",
      model: agent.model,
    };
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

export async function updateAmaAgentConfig(env: Env, ownerId: string, projectId: string, agentId: string, input: AmaAgentInput): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaErrorDetails("update runtime agent config", () =>
    client.agents.update(agentId, {
      name: input.name,
      description: input.description ?? null,
      instructions: input.instructions ?? null,
      ...(input.provider ? { providerId: input.provider } : {}),
      model: input.model ?? null,
      role: input.role ?? null,
      skills: input.skills ?? [],
      subagents: input.subagents ?? [],
      capabilityTags: input.capabilityTags ?? [],
      handoffPolicy: input.handoffPolicy ?? {},
      metadata: input.metadata ?? {},
      memoryPolicy: input.memoryPolicy ?? { enabled: false },
    }),
  );
}

// AMA has no hard delete for agents/environments (they are FK-referenced by
// sessions/runners/versions with no cascade). Deleting an AK agent/machine
// archives the corresponding AMA resource (soft delete: hidden from active
// lists, history preserved). Archive is the {archived:true} lifecycle PATCH.
export async function archiveAmaAgent(env: Env, ownerId: string, projectId: string, agentId: string): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaErrorDetails("archive runtime agent", () => client.agents.update(agentId, { archived: true }));
}

export async function archiveAmaEnvironment(env: Env, ownerId: string, projectId: string, environmentId: string): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaErrorDetails("archive runtime environment", () => client.environments.update(environmentId, { archived: true }));
}

export async function readAmaEnvironment(env: Env, ownerId: string, projectId: string, environmentId: string): Promise<AmaEnvironment> {
  const client = await createAmaClient(env, ownerId, projectId);
  const environment = await client.environments.get(environmentId);
  return { id: environment.id };
}

// Self-heal probes: AMA resources we hold an id for can be deleted out of band
// (e.g. an AMA data migration that resets the control plane). These let the
// "ensure" paths detect a dangling id and re-provision instead of dispatching
// against a resource that no longer exists.
export async function readAmaProject(env: Env, ownerId: string, projectId: string): Promise<AmaProject | null> {
  const client = await createAmaClient(env, ownerId, projectId);
  try {
    const project = await client.projects.get(projectId);
    return { id: project.id, name: project.name };
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

export async function amaEnvironmentExists(env: Env, ownerId: string, projectId: string, environmentId: string): Promise<boolean> {
  const client = await createAmaClient(env, ownerId, projectId);
  try {
    await client.environments.get(environmentId);
    return true;
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return false;
    throw error;
  }
}

export function resolveAmaProviderModelProfile(input: { runtime: string; preferredModel?: string | null }): AmaProviderModelProfile {
  const { runtime, preferredModel } = input;
  const configured = RUNTIME_PROVIDER_PROFILES[runtime];
  if (!configured) {
    throw new Error(`No AK runtime provider mapping is configured for runtime ${runtime}`);
  }
  const model = preferredModel ?? null;
  if (configured.cloud) {
    // Cloud agents must pin a catalog model; AMA validates the (vendor, model)
    // pair against the global catalog at session creation.
    if (!model) {
      throw new Error(`A cloud (${runtime}) agent must pin a model from the AMA catalog before dispatch`);
    }
    return { runtime, provider: vendorFromModelId(model), model };
  }
  return { runtime, provider: configured.providerSlug, model };
}

export async function createAmaFederatedTenant(env: Env, ownerId: string, input: AmaFederatedTenantInput): Promise<void> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  try {
    await client.federatedTenants.create({
      issuer: input.issuer,
      externalTenantId: input.externalTenantId,
      capabilities: input.capabilities ?? RUNNER_FEDERATION_CAPABILITIES,
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  } catch (error) {
    // 409: (issuer, externalTenantId) is already bound to this project — the
    // federation binding is idempotent, so a re-onboard is a no-op success.
    if ((error as { status?: unknown }).status === 409) return;
    const status = typeof (error as { status?: unknown }).status === "number" ? ` HTTP ${(error as { status: number }).status}` : "";
    const responseText =
      typeof (error as { responseText?: unknown }).responseText === "string" ? `: ${(error as { responseText: string }).responseText}` : "";
    throw new Error(`AMA federated tenant binding failed${status}${responseText}`);
  }
}

export async function createAmaSessionSecret(env: Env, ownerId: string, input: AmaSessionSecretInput): Promise<AmaSessionSecret> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const credential = await client.vaults.createCredential(input.vaultId, {
    name: input.name,
    type: "session_env_secret",
    metadata: input.metadata ?? {},
    secret: {
      provider: "ama-managed",
      secretValue: input.secretValue,
      referenceName: input.name,
    },
  });
  if (!credential.activeVersionId) {
    throw new Error("AMA vault credential response did not include activeVersionId");
  }
  return { credentialId: credential.id, activeVersionId: credential.activeVersionId };
}

export interface AmaSessionUsageTotals {
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
}

export async function readAmaSessionUsageTotals(
  env: Env,
  ownerId: string,
  projectId: string,
  sessionId: string,
): Promise<AmaSessionUsageTotals | null> {
  const client = await createAmaClient(env, ownerId, projectId);
  // /api/v1 usage-summary groups only by provider/model/agent; per-session
  // totals come from summing the session's usage records. The endpoint caps
  // limit at 100, so page through all records via the cursor.
  const totals: AmaSessionUsageTotals = { promptTokens: 0, completionTokens: 0, costMicros: 0 };
  let records = 0;
  let cursor: string | undefined;
  do {
    const page = await client.usage.listRecords({ sessionId, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const record of page.data) {
      totals.promptTokens += record.promptTokens ?? 0;
      totals.completionTokens += record.completionTokens ?? 0;
      totals.costMicros += record.costMicros ?? 0;
    }
    records += page.data.length;
    cursor = page.pagination?.nextCursor ?? undefined;
  } while (cursor);
  return records === 0 ? null : totals;
}

export async function revokeAmaVaultCredential(env: Env, ownerId: string, projectId: string, vaultId: string, credentialId: string): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await client.vaults.updateCredential(vaultId, credentialId, { state: "revoked", revokeReason: "AK agent session closed" });
}

export async function sendAmaSessionMessage(
  env: Env,
  ownerId: string,
  projectId: string,
  sessionId: string,
  message: string,
): Promise<AmaRuntimeCommandResult> {
  const client = await createAmaClient(env, ownerId, projectId);
  // A 201 means the prompt message was accepted and queued for the session.
  await client.sessions.createMessage(sessionId, { type: "prompt", content: message });
  return { accepted: true };
}

export async function readAmaSession(env: Env, ownerId: string, sessionId: string, projectId?: string): Promise<Record<string, unknown> | null> {
  const client = await createAmaClient(env, ownerId, projectId);
  try {
    return (await client.sessions.get(sessionId)) as unknown as Record<string, unknown>;
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

export async function listAmaAgents(env: Env, ownerId: string): Promise<AmaListResponse<Record<string, unknown>>> {
  const client = await createAmaClient(env, ownerId);
  return (await client.agents.list({ limit: 100 })) as unknown as AmaListResponse<Record<string, unknown>>;
}

export async function listAmaEnvironments(env: Env, ownerId: string): Promise<AmaListResponse<Record<string, unknown>>> {
  const client = await createAmaClient(env, ownerId);
  return (await client.environments.list({ limit: 100 })) as unknown as AmaListResponse<Record<string, unknown>>;
}

export interface AmaCatalogModel {
  providerId: string;
  modelId: string;
  displayName?: string;
  availability: string;
}

// AMA's global model catalog (auto-discovered from models.dev, the authority —
// never hardcoded here). It is runtime-agnostic: every cloud model dispatches
// the same way through the Workers AI binding. The caller filters/orders it for
// the cloud (ama) runtime; self-hosted runtimes ignore it (their models come
// from the runner's live capabilities).
export async function listAmaCatalogModels(env: Env, ownerId: string): Promise<AmaCatalogModel[]> {
  const client = await createAmaClient(env, ownerId);
  // GET /api/v1/providers/models returns the entire catalog in one envelope
  // (the AMA route lists all rows; pagination is always {hasMore:false}), so no
  // cursor loop is needed.
  const response = await client.models.list();
  return response.data as unknown as AmaCatalogModel[];
}

export async function listAmaRunners(env: Env, ownerId: string, projectId: string, environmentId: string): Promise<AmaListResponse<AmaRunner>> {
  const client = await createAmaClient(env, ownerId, projectId);
  const page = await client.runners.list({ environmentId, limit: 100 });
  // /api/v1 runners report lifecycle as `state`; AK's dispatch gate reads
  // `status` (active | draining | disabled | offline).
  return {
    data: page.data.map((runner) => ({
      id: runner.id,
      environmentId: runner.environmentId,
      status: runner.state,
      capabilities: runner.capabilities,
      currentLoad: runner.currentLoad,
      maxConcurrent: runner.maxConcurrent,
      lastHeartbeatAt: runner.lastHeartbeatAt,
      runtimeUsage: runner.runtimeUsage,
    })),
    pagination: page.pagination,
  };
}

interface AmaTriggerResponse {
  id: string;
  agentId: string;
  environmentId: string | null;
  name: string;
  promptTemplate: string;
  schedule: { intervalSeconds: number; windowSeconds?: number };
  enabled: boolean;
  archivedAt: string | null;
  lastDispatchedAt: string | null;
  lastRunId: string | null;
}

interface AmaTriggerRunResponse {
  id: string;
  projectId: string;
  triggerId: string;
  scheduledFor: string;
  heartbeatAt: string;
  state: string;
  sessionId: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// /api/v1 triggers expose enablement as a boolean + an archive timestamp; AK's
// maintainer status is the tri-state derived from them.
function amaTriggerStatus(trigger: AmaTriggerResponse): AmaScheduledTrigger["status"] {
  if (trigger.archivedAt) return "archived";
  return trigger.enabled ? "active" : "paused";
}

function toAmaScheduledTrigger(trigger: AmaTriggerResponse): AmaScheduledTrigger {
  return {
    id: trigger.id,
    agentId: trigger.agentId,
    environmentId: trigger.environmentId,
    name: trigger.name,
    promptTemplate: trigger.promptTemplate,
    schedule: { intervalSeconds: trigger.schedule.intervalSeconds, windowSeconds: trigger.schedule.windowSeconds },
    status: amaTriggerStatus(trigger),
    lastDispatchedAt: trigger.lastDispatchedAt,
    lastRunId: trigger.lastRunId,
  };
}

function toAmaScheduledTriggerRun(run: AmaTriggerRunResponse): AmaScheduledTriggerRun {
  return {
    id: run.id,
    projectId: run.projectId,
    triggerId: run.triggerId,
    scheduledFor: run.scheduledFor,
    heartbeatAt: run.heartbeatAt,
    status: run.state,
    sessionId: run.sessionId,
    errorMessage: run.errorMessage,
    metadata: run.metadata,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export async function listAmaScheduledTriggerRuns(
  env: Env,
  ownerId: string,
  projectId: string,
  triggerId: string,
  options: { limit?: number } = {},
): Promise<AmaListResponse<AmaScheduledTriggerRun>> {
  const client = await createAmaClient(env, ownerId, projectId);
  const page = await client.triggers.listRuns(triggerId, { limit: options.limit ?? 20 });
  return { data: page.data.map(toAmaScheduledTriggerRun), pagination: page.pagination };
}

export async function stopAmaSession(
  env: Env,
  ownerId: string,
  projectId: string,
  sessionId: string,
  reason: "user_requested" | "timeout" | "policy" | "runtime_error",
) {
  const client = await createAmaClient(env, ownerId, projectId);
  // /api/v1 has no dedicated stop verb: transition the session to `stopped`.
  await client.sessions.update(sessionId, { state: "stopped", metadata: { stopReason: reason } });
}

export async function createAmaScheduledAgentTrigger(env: Env, ownerId: string, input: AmaScheduledTriggerInput): Promise<AmaScheduledTrigger> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const trigger = await client.triggers.create({
    agentId: input.agentId,
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    runtime: input.runtime as Runtime,
    name: input.name,
    promptTemplate: input.promptTemplate,
    resourceRefs: input.resourceRefs ?? [],
    env: input.runtimeEnv ?? {},
    secretEnv: toAmaSecretEnv(input.runtimeSecretEnv ?? []),
    schedule: { type: "interval", intervalSeconds: input.intervalSeconds },
    enabled: (input.status ?? "active") !== "paused",
  });
  return toAmaScheduledTrigger(trigger);
}

export async function updateAmaScheduledAgentTrigger(
  env: Env,
  ownerId: string,
  projectId: string,
  scheduleId: string,
  input: AmaScheduledTriggerUpdate,
): Promise<AmaScheduledTrigger> {
  const body: UpdateTriggerRequest = {};
  if (input.agentId !== undefined) body.agentId = input.agentId;
  // null unpins the environment (AMA resolves one per dispatch); the contract
  // types this as optional-string, so widen for the null case.
  if (input.environmentId !== undefined) body.environmentId = input.environmentId as string | undefined;
  if (input.runtime !== undefined) body.runtime = input.runtime as Runtime;
  if (input.name !== undefined) body.name = input.name;
  if (input.promptTemplate !== undefined) body.promptTemplate = input.promptTemplate;
  if (input.intervalSeconds !== undefined) body.schedule = { type: "interval", intervalSeconds: input.intervalSeconds };
  if (input.status !== undefined) body.enabled = input.status !== "paused";
  const client = await createAmaClient(env, ownerId, projectId);
  const trigger = await client.triggers.update(scheduleId, body);
  return toAmaScheduledTrigger(trigger);
}

export async function deleteAmaScheduledAgentTrigger(env: Env, ownerId: string, projectId: string, scheduleId: string): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await client.triggers.delete(scheduleId);
}

// Resolves the AMA access token for the linked AMA account of the AK user
// `ownerId`. BetterAuth's getAccessToken auto-refreshes via the stored refresh
// token. Surfaces a clear "no linked AMA account" error when the user hasn't
// connected AMA (BetterAuth raises ACCOUNT_NOT_FOUND); other failures (e.g. a
// revoked refresh token, network) propagate unchanged.
async function userAmaAccessToken(env: Env, ownerId: string): Promise<string> {
  const requestKey = `${ownerId}:ama`;
  const existing = amaAccessTokenRequests.get(requestKey);
  if (existing) return existing;

  const request = resolveUserAmaAccessToken(env, ownerId).finally(() => {
    amaAccessTokenRequests.delete(requestKey);
  });
  amaAccessTokenRequests.set(requestKey, request);
  return request;
}

async function resolveUserAmaAccessToken(env: Env, ownerId: string): Promise<string> {
  const auth = createAuth(env);
  let res: { accessToken?: string } | undefined;
  try {
    res = await auth.api.getAccessToken({ body: { providerId: "ama", userId: ownerId } });
  } catch (error) {
    if (isAmaAccountNotFound(error)) {
      throw new Error(`No linked AMA account for user ${ownerId}; connect AMA to enable cloud scheduling`);
    }
    throw error;
  }
  if (!res?.accessToken) {
    throw new Error(`No linked AMA account for user ${ownerId}; connect AMA to enable cloud scheduling`);
  }
  return res.accessToken;
}

function isAmaAccountNotFound(error: unknown): boolean {
  const code = (error as { body?: { code?: unknown } })?.body?.code;
  if (code === "ACCOUNT_NOT_FOUND") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /account not found/i.test(message);
}

async function createAmaClient(env: Env, ownerId: string, projectId?: string) {
  const baseUrl = requireEnv(env.AMA_ORIGIN, "AMA_ORIGIN");
  const accessToken = await userAmaAccessToken(env, ownerId);
  return createSdkClient({ baseUrl, accessToken, projectId });
}

// The token-bearing AMA browser-socket URL the SPA connects to directly (no AK
// proxy/bridge): live events are pushed + history backfilled over one WebSocket,
// replacing the chat's poll loop. The user's AMA access token rides as the
// `access_token` query param (the AMA socket route authenticates on it).
export async function getAmaSessionSocketUrl(env: Env, ownerId: string, sessionId: string, projectId?: string): Promise<string> {
  const baseUrl = requireEnv(env.AMA_ORIGIN, "AMA_ORIGIN");
  const accessToken = await userAmaAccessToken(env, ownerId);
  const wsBase = baseUrl.replace(/^http(s?):\/\//i, (_match, secure) => `ws${secure}://`);
  // The browser connects with no request headers, so the session's project rides
  // as a query param (the AMA socket route reads x-ama-project-id from header OR
  // query). Without it the token resolves to the user's default project and the
  // session — which lives in the machine's project — reads as "not found".
  const projectParam = projectId ? `&x-ama-project-id=${encodeURIComponent(projectId)}` : "";
  return `${wsBase}/api/v1/sessions/${encodeURIComponent(sessionId)}/socket?access_token=${encodeURIComponent(accessToken)}${projectParam}`;
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
