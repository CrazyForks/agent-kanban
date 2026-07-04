import {
  createAmaClient as createSdkClient,
  type EnvFromEntry,
  type RuntimeName,
  type Agent as SdkAgent,
  type MemoryStore as SdkMemoryStore,
  type MemoryStoreMemory as SdkMemoryStoreMemory,
  type Session as SdkSession,
  type Trigger as SdkTrigger,
  type TriggerRun as SdkTriggerRun,
  type UpdateTriggerRequest,
  type Volume,
  type VolumeMount,
} from "@any-managed-agents/sdk";
import { amaOidcResource, oidcDiscoveryUrl } from "./betterAuth";
import type { Env } from "./types";

const amaAccessTokenRequests = new Map<string, Promise<string>>();
const AMA_ACCESS_TOKEN_REFRESH_SKEW_MS = 30_000;

export class AmaLinkedAccountAuthError extends Error {
  readonly status = 401;
  readonly code = "AMA_RECONNECT_REQUIRED";

  constructor(message = "AMA rejected the linked account token. Reconnect AMA in Account settings, then run ak start again.") {
    super(message);
    this.name = "AmaLinkedAccountAuthError";
  }
}

export type AmaResourceRef = Record<string, unknown>;
export interface AmaRuntimeSecretEnvRef {
  name: string;
  vaultId: string;
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

interface AmaLinkedAccountRow {
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
}

interface AmaRefreshTokenResult {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt: string | null;
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
  metadata?: Record<string, unknown>;
}

export interface AmaScheduledTriggerUpdate {
  agentId?: string;
  environmentId?: string | null;
  runtime?: string;
  name?: string;
  promptTemplate?: string;
  intervalSeconds?: number;
  status?: "active" | "paused";
  resourceRefs?: AmaResourceRef[];
  runtimeEnv?: Record<string, string>;
  runtimeSecretEnv?: AmaRuntimeSecretEnvRef[];
  metadata?: Record<string, unknown>;
}

export interface AmaHttpTriggerInput {
  projectId: string;
  agentId: string;
  environmentId?: string | null;
  runtime: string;
  name: string;
  promptTemplate: string;
  status?: "active" | "paused";
  resourceRefs?: AmaResourceRef[];
  runtimeEnv?: Record<string, string>;
  runtimeSecretEnv?: AmaRuntimeSecretEnvRef[];
  metadata?: Record<string, unknown>;
}

export interface AmaHttpTriggerUpdate {
  agentId?: string;
  environmentId?: string | null;
  runtime?: string;
  name?: string;
  promptTemplate?: string;
  status?: "active" | "paused";
  resourceRefs?: AmaResourceRef[];
  runtimeEnv?: Record<string, string>;
  runtimeSecretEnv?: AmaRuntimeSecretEnvRef[];
  metadata?: Record<string, unknown>;
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

export interface AmaHttpTrigger {
  id: string;
  agentId: string;
  environmentId: string | null;
  name: string;
  promptTemplate: string;
  status: "active" | "paused" | "archived";
  lastDispatchedAt: string | null;
  lastRunId: string | null;
}

export interface AmaTriggerRun {
  id: string;
  projectId: string;
  triggerId: string;
  scheduledFor: string | null;
  heartbeatAt: string | null;
  triggeredAt: string;
  status: string;
  sessionId: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AmaMemoryStore {
  id: string;
  name: string;
}

export interface AmaMemoryStoreInput {
  projectId: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface AmaMemoryStoreMemory {
  id: string;
  storeId: string;
  projectId: string;
  path: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AmaHttpTriggerRunInput {
  projectId: string;
  triggerId: string;
  body: Record<string, unknown>;
  idempotencyKey?: string | null;
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
export interface AmaRuntimeInventory {
  runtime: string;
  version?: string;
  state: string;
  detail?: string;
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
  runtimeInventory?: AmaRuntimeInventory[];
}

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

// AMA is "configured" for this AK instance when the AMA origin and the OIDC
// client used to register the provider are present. Per-call authorization
// is the logged-in user's own linked AMA account (resolved at request time).
function hasAmaOidcClient(env: Env): boolean {
  return Boolean(env.AMA_OIDC_ISSUER && env.AMA_OIDC_CLIENT_ID && env.AMA_OIDC_CLIENT_SECRET);
}

export function isAmaRuntimeConfigured(env: Env): boolean {
  return Boolean(env.AMA_ORIGIN && hasAmaOidcClient(env));
}

export function isAmaTaskDispatchConfigured(env: Env): boolean {
  return isAmaRuntimeConfigured(env);
}

export async function createAmaTaskSession(env: Env, ownerId: string, input: AmaTaskSessionInput): Promise<AmaSessionDispatch> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const envFrom = toAmaEnvFrom(input.runtimeSecretEnv ?? []);
  const resources = toAmaRuntimeResources(input.resourceRefs ?? [], input.runtimeSecretEnv ?? []);
  const session = await withAmaErrorDetails("create session", () =>
    client.sessions.create({
      metadata: { name: input.title },
      spec: {
        agentId: input.agentId,
        environmentId: input.environmentId,
        runtime: toRuntimeName(input.runtime),
        env: input.runtimeEnv ?? {},
        envFrom,
        volumes: resources.volumes,
        volumeMounts: resources.volumeMounts,
      },
      prompt: input.initialPrompt ?? "",
    }),
  );

  return {
    projectId: input.projectId,
    agentId: session.spec.agentId,
    environmentId: session.spec.environmentId ?? input.environmentId,
    sessionId: session.metadata.uid,
    status: session.status.phase,
    statusReason: session.status.reason,
  };
}

function toRuntimeName(runtime: string): RuntimeName {
  return runtime as RuntimeName;
}

function credentialVersionSecretRef(entry: Pick<AmaRuntimeSecretEnvRef, "vaultId" | "credentialId" | "versionId">): string {
  if (!entry.vaultId) throw new Error(`AMA secret env reference for credential ${entry.credentialId} is missing vaultId`);
  const vaultId = encodeURIComponent(entry.vaultId);
  const credentialId = encodeURIComponent(entry.credentialId);
  if (entry.versionId) {
    return `ama://vaults/${vaultId}/credentials/${credentialId}/versions/${encodeURIComponent(entry.versionId)}`;
  }
  return `ama://vaults/${vaultId}/credentials/${credentialId}`;
}

function toAmaEnvFrom(entries: AmaRuntimeSecretEnvRef[]): EnvFromEntry[] {
  return entries.map((entry) => ({
    type: "secret",
    name: entry.name,
    secretRef: credentialVersionSecretRef(entry),
    key: "value",
  }));
}

function toAmaRuntimeResources(
  resourceRefs: AmaResourceRef[],
  secretEnv: AmaRuntimeSecretEnvRef[],
): { volumes: Volume[]; volumeMounts: VolumeMount[] } {
  const githubCredential = secretEnv.find((entry) => entry.name === "GH_TOKEN");
  const volumes: Volume[] = [];
  const volumeMounts: VolumeMount[] = [];
  for (const [index, resource] of resourceRefs.entries()) {
    if (resource.type === "github_repository" && typeof resource.owner === "string" && typeof resource.repo === "string") {
      const name = index === 0 ? "repo" : `repo-${index + 1}`;
      volumes.push({
        name,
        type: "git_repository",
        url: `https://github.com/${resource.owner}/${resource.repo}.git`,
        ...(githubCredential ? { secretRef: credentialVersionSecretRef(githubCredential) } : {}),
      });
      volumeMounts.push({ name, mountPath: `/workspace/repos/github.com/${resource.owner}/${resource.repo}` });
    }
    if (resource.type === "memory_store" && typeof resource.storeId === "string") {
      const name = index === 0 ? "memory" : `memory-${index + 1}`;
      const readOnly = resource.access === "read_only";
      volumes.push({
        name,
        type: "memory",
        memoryRef: `ama://memories/${encodeURIComponent(resource.storeId)}`,
        access: readOnly ? "read_only" : "read_write",
      });
      volumeMounts.push({ name, mountPath: `/workspace/.ama/memory-stores/${encodeURIComponent(resource.storeId)}`, readOnly });
    }
  }
  return { volumes, volumeMounts };
}

function triggerTemplateMetadata(metadata: Record<string, unknown> | undefined) {
  return {
    labels: stringRecord((metadata?.labels as Record<string, unknown> | undefined) ?? {}),
    annotations: stringRecord((metadata?.annotations as Record<string, unknown> | undefined) ?? {}),
  };
}

function triggerExecutionSpec(input: AmaScheduledTriggerInput | AmaHttpTriggerInput) {
  const resources = toAmaRuntimeResources(input.resourceRefs ?? [], input.runtimeSecretEnv ?? []);
  return {
    agentId: input.agentId,
    ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
    runtime: toRuntimeName(input.runtime),
    env: input.runtimeEnv ?? {},
    envFrom: toAmaEnvFrom(input.runtimeSecretEnv ?? []),
    volumes: resources.volumes,
    volumeMounts: resources.volumeMounts,
    promptTemplate: input.promptTemplate,
  };
}

type AmaTriggerTemplateSpecUpdate = NonNullable<NonNullable<UpdateTriggerRequest["spec"]>["template"]>["spec"];

function triggerExecutionSpecUpdate(input: AmaScheduledTriggerUpdate | AmaHttpTriggerUpdate): AmaTriggerTemplateSpecUpdate | undefined {
  const spec: Record<string, unknown> = {};
  if (input.agentId !== undefined) spec.agentId = input.agentId;
  if (input.environmentId !== undefined) spec.environmentId = input.environmentId;
  if (input.runtime !== undefined) spec.runtime = toRuntimeName(input.runtime);
  if (input.runtimeEnv !== undefined) spec.env = input.runtimeEnv;
  if (input.runtimeSecretEnv !== undefined) spec.envFrom = toAmaEnvFrom(input.runtimeSecretEnv);
  if (input.resourceRefs !== undefined) {
    const resources = toAmaRuntimeResources(input.resourceRefs, input.runtimeSecretEnv ?? []);
    spec.volumes = resources.volumes;
    spec.volumeMounts = resources.volumeMounts;
  }
  if (input.promptTemplate !== undefined) spec.promptTemplate = input.promptTemplate;
  return Object.keys(spec).length > 0 ? (spec as AmaTriggerTemplateSpecUpdate) : undefined;
}

function stringRecord(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])));
}

function toAmaAgentSubagents(subagents: Record<string, unknown>[]) {
  return subagents.map((subagent) => ({
    name: String(subagent.name ?? subagent.username ?? "subagent"),
    description: String(subagent.description ?? subagent.bio ?? ""),
    systemPrompt: String(subagent.systemPrompt ?? subagent.instructions ?? ""),
    model: typeof subagent.model === "string" ? subagent.model : null,
    allowedTools: Array.isArray(subagent.allowedTools) ? subagent.allowedTools.filter((tool): tool is string => typeof tool === "string") : [],
    skills: Array.isArray(subagent.skills) ? subagent.skills.filter((skill): skill is string => typeof skill === "string") : [],
    mcpConnectors: Array.isArray(subagent.mcpConnectors)
      ? subagent.mcpConnectors.filter((connector): connector is string => typeof connector === "string")
      : [],
  }));
}

function toAmaAgent(agent: SdkAgent, fallbackProvider: string): AmaAgent {
  return {
    id: agent.metadata.uid,
    projectId: agent.metadata.projectId ?? "",
    name: agent.metadata.name,
    provider: agent.spec.provider ?? fallbackProvider,
    model: agent.spec.model,
  };
}

function normalizeAgent(agent: SdkAgent): Record<string, unknown> {
  return {
    ...agent,
    id: agent.metadata.uid,
    projectId: agent.metadata.projectId,
    name: agent.metadata.name,
    description: agent.metadata.description,
    provider: agent.spec.provider,
    providerId: agent.spec.provider,
    model: agent.spec.model,
    archivedAt: agent.metadata.archivedAt,
  };
}

function normalizeEnvironment(environment: {
  metadata: { uid: string; projectId: string | null; name: string; description: string | null; archivedAt: string | null };
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...environment,
    id: environment.metadata.uid,
    projectId: environment.metadata.projectId,
    name: environment.metadata.name,
    description: environment.metadata.description,
    archivedAt: environment.metadata.archivedAt,
  };
}

function normalizeSession(session: SdkSession): Record<string, unknown> {
  return {
    ...session,
    id: session.metadata.uid,
    projectId: session.metadata.projectId,
    name: session.metadata.name,
    title: session.metadata.name,
    agentId: session.spec.agentId,
    environmentId: session.spec.environmentId,
    runtime: session.spec.runtime,
    state: session.status.phase,
    stateReason: session.status.reason,
    status: session.status.phase,
    createdAt: session.metadata.createdAt,
    updatedAt: session.metadata.updatedAt,
    metadata: {
      ...session.metadata,
      ...session.metadata.labels,
      ...session.metadata.annotations,
    },
  };
}

function toAmaMemoryStore(store: SdkMemoryStore): AmaMemoryStore {
  return { id: store.metadata.uid, name: store.metadata.name };
}

export async function createAmaAgent(env: Env, ownerId: string, input: AmaAgentInput): Promise<AmaAgent> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const agent = await withAmaErrorDetails("create runtime agent", () =>
    client.agents.create({
      metadata: {
        name: input.name,
        description: input.description ?? null,
      },
      spec: {
        systemPrompt: input.instructions ?? "",
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        skills: input.skills ?? [],
        subagents: toAmaAgentSubagents(input.subagents ?? []),
        allowedTools: [],
        mcpConnectors: [],
      },
    }),
  );
  return toAmaAgent(agent, input.provider);
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
      metadata: {
        name: input.name,
        description: input.description ?? null,
      },
      spec: { scope: input.scope },
    }),
  );
  return { id: vault.metadata.uid };
}

export async function createAmaEnvironment(env: Env, ownerId: string, input: AmaEnvironmentInput): Promise<AmaEnvironment> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const environment = await withAmaErrorDetails("create environment", () =>
    client.environments.create({
      metadata: {
        name: input.name,
        description: input.description ?? null,
      },
      spec: { type: input.hostingMode },
    }),
  );
  return { id: environment.metadata.uid };
}

async function withAmaErrorDetails<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throwIfAmaAuthError(error);
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
    return toAmaAgent(agent, "");
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throwIfAmaAuthError(error);
    throw error;
  }
}

export async function updateAmaAgentConfig(env: Env, ownerId: string, projectId: string, agentId: string, input: AmaAgentInput): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaErrorDetails("update runtime agent config", () =>
    client.agents.update(agentId, {
      metadata: {
        name: input.name,
        description: input.description ?? null,
      },
      spec: {
        systemPrompt: input.instructions ?? "",
        ...(input.provider ? { provider: input.provider } : {}),
        model: input.model ?? null,
        skills: input.skills ?? [],
        subagents: toAmaAgentSubagents(input.subagents ?? []),
        allowedTools: [],
        mcpConnectors: [],
      },
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
    throwIfAmaAuthError(error);
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
    throwIfAmaAuthError(error);
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

export async function createAmaSessionSecret(env: Env, ownerId: string, input: AmaSessionSecretInput): Promise<AmaSessionSecret> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const credential = await client.vaults.createCredential(input.vaultId, {
    name: input.name,
    type: "opaque",
    metadata: input.metadata ?? {},
    secret: {
      stringData: { value: input.secretValue },
      referenceName: input.name,
      metadata: input.metadata ?? {},
    },
  });
  if (!credential.status.activeVersionId) {
    throw new Error("AMA vault credential response did not include activeVersionId");
  }
  return { credentialId: credential.metadata.uid, activeVersionId: credential.status.activeVersionId };
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
    return normalizeSession(await client.sessions.get(sessionId));
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throwIfAmaAuthError(error);
    throw error;
  }
}

export async function listAmaSessions(
  env: Env,
  ownerId: string,
  projectId: string,
  options: { limit?: number; cursor?: string; state?: string; archived?: boolean; labelSelector?: string } = {},
): Promise<AmaListResponse<Record<string, unknown>>> {
  const client = await createAmaClient(env, ownerId, projectId);
  type AmaSessionState = "pending" | "running" | "idle" | "closed" | "error";
  type AmaArchivedFilter = "true" | "false";
  const query = {
    limit: options.limit ?? 50,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.state ? { state: options.state as AmaSessionState } : {}),
    ...(options.archived !== undefined ? { archived: (options.archived ? "true" : "false") as AmaArchivedFilter } : {}),
    ...(options.labelSelector ? { labelSelector: options.labelSelector } : {}),
  };
  const page = await client.sessions.list(query);
  return { data: page.data.map(normalizeSession), pagination: page.pagination };
}

export async function listAmaAgents(env: Env, ownerId: string): Promise<AmaListResponse<Record<string, unknown>>> {
  const client = await createAmaClient(env, ownerId);
  const page = await client.agents.list({ limit: 100 });
  return { data: page.data.map(normalizeAgent), pagination: page.pagination };
}

export async function listAmaEnvironments(env: Env, ownerId: string): Promise<AmaListResponse<Record<string, unknown>>> {
  const client = await createAmaClient(env, ownerId);
  const page = await client.environments.list({ limit: 100 });
  return { data: page.data.map(normalizeEnvironment), pagination: page.pagination };
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
  const response = await client.providers.listModels();
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
      runtimeInventory: runner.runtimeInventory,
    })),
    pagination: page.pagination,
  };
}

interface AmaTriggerResponse {
  metadata: {
    uid: string;
    name: string;
    archivedAt: string | null;
  };
  spec: {
    source: { type: "schedule"; schedule: { intervalSeconds: number; windowSeconds?: number } } | { type: "http" };
    suspend: boolean;
    template: {
      spec: {
        agentId: string;
        environmentId: string | null;
        promptTemplate: string;
      };
    };
  };
  status: {
    lastDispatchedAt: string | null;
    lastRunId: string | null;
  };
}

interface AmaTriggerRunResponse {
  metadata: {
    uid: string;
    projectId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  spec: {
    triggerId: string;
    scheduledFor: string | null;
    metadata: Record<string, unknown>;
  };
  status: {
    phase: string;
    heartbeatAt: string | null;
    triggeredAt: string;
    sessionId: string | null;
    errorMessage: string | null;
  };
}

// /api/v1 triggers expose enablement as a boolean + an archive timestamp; AK's
// maintainer status is the tri-state derived from them.
function amaTriggerStatus(trigger: AmaTriggerResponse): AmaScheduledTrigger["status"] {
  if (trigger.metadata.archivedAt) return "archived";
  return trigger.spec.suspend ? "paused" : "active";
}

function toAmaScheduledTrigger(trigger: AmaTriggerResponse): AmaScheduledTrigger {
  if (trigger.spec.source.type !== "schedule") {
    throw new Error(`AMA trigger ${trigger.metadata.uid} is not scheduled`);
  }
  return {
    id: trigger.metadata.uid,
    agentId: trigger.spec.template.spec.agentId,
    environmentId: trigger.spec.template.spec.environmentId,
    name: trigger.metadata.name,
    promptTemplate: trigger.spec.template.spec.promptTemplate,
    schedule: { intervalSeconds: trigger.spec.source.schedule.intervalSeconds, windowSeconds: trigger.spec.source.schedule.windowSeconds },
    status: amaTriggerStatus(trigger),
    lastDispatchedAt: trigger.status.lastDispatchedAt,
    lastRunId: trigger.status.lastRunId,
  };
}

function toAmaHttpTrigger(trigger: AmaTriggerResponse): AmaHttpTrigger {
  return {
    id: trigger.metadata.uid,
    agentId: trigger.spec.template.spec.agentId,
    environmentId: trigger.spec.template.spec.environmentId,
    name: trigger.metadata.name,
    promptTemplate: trigger.spec.template.spec.promptTemplate,
    status: amaTriggerStatus(trigger),
    lastDispatchedAt: trigger.status.lastDispatchedAt,
    lastRunId: trigger.status.lastRunId,
  };
}

function toAmaTriggerRun(run: AmaTriggerRunResponse): AmaTriggerRun {
  return {
    id: run.metadata.uid,
    projectId: run.metadata.projectId ?? "",
    triggerId: run.spec.triggerId,
    scheduledFor: run.spec.scheduledFor,
    heartbeatAt: run.status.heartbeatAt,
    triggeredAt: run.status.triggeredAt,
    status: run.status.phase,
    sessionId: run.status.sessionId,
    errorMessage: run.status.errorMessage,
    metadata: run.spec.metadata,
    createdAt: run.metadata.createdAt,
    updatedAt: run.metadata.updatedAt,
  };
}

export async function listAmaTriggerRuns(
  env: Env,
  ownerId: string,
  projectId: string,
  triggerId: string,
  options: { limit?: number } = {},
): Promise<AmaListResponse<AmaTriggerRun>> {
  const client = await createAmaClient(env, ownerId, projectId);
  const page = await client.triggers.listRuns(triggerId, { limit: options.limit ?? 20 });
  return { data: page.data.map((run) => toAmaTriggerRun(run as SdkTriggerRun)), pagination: page.pagination };
}

export async function closeAmaSession(
  env: Env,
  ownerId: string,
  projectId: string,
  sessionId: string,
  reason: "user_requested" | "timeout" | "policy" | "runtime_error",
) {
  const client = await createAmaClient(env, ownerId, projectId);
  await client.sessions.update(sessionId, { state: "closed", metadata: { annotations: { closeReason: reason } } });
}

export async function reopenAmaSession(
  env: Env,
  ownerId: string,
  projectId: string,
  sessionId: string,
  metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> },
) {
  const client = await createAmaClient(env, ownerId, projectId);
  await client.sessions.update(sessionId, { state: "idle", ...(metadata ? { metadata } : {}) });
}

export async function createAmaScheduledAgentTrigger(env: Env, ownerId: string, input: AmaScheduledTriggerInput): Promise<AmaScheduledTrigger> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const trigger = await withAmaErrorDetails("create scheduled trigger", () =>
    client.triggers.create({
      metadata: { name: input.name },
      spec: {
        source: { type: "schedule", schedule: { type: "interval", intervalSeconds: input.intervalSeconds } },
        suspend: (input.status ?? "active") === "paused",
        template: {
          metadata: triggerTemplateMetadata(input.metadata),
          spec: triggerExecutionSpec(input),
        },
      },
    }),
  );
  return toAmaScheduledTrigger(trigger as SdkTrigger);
}

export async function createAmaHttpAgentTrigger(env: Env, ownerId: string, input: AmaHttpTriggerInput): Promise<AmaHttpTrigger> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const trigger = await withAmaErrorDetails("create HTTP trigger", () =>
    client.triggers.create({
      metadata: { name: input.name },
      spec: {
        source: { type: "http" },
        suspend: (input.status ?? "active") === "paused",
        template: {
          metadata: triggerTemplateMetadata(input.metadata),
          spec: triggerExecutionSpec(input),
        },
      },
    }),
  );
  return toAmaHttpTrigger(trigger as SdkTrigger);
}

export async function updateAmaScheduledAgentTrigger(
  env: Env,
  ownerId: string,
  projectId: string,
  scheduleId: string,
  input: AmaScheduledTriggerUpdate,
): Promise<AmaScheduledTrigger> {
  const body: UpdateTriggerRequest = {};
  if (input.name !== undefined) body.metadata = { name: input.name };
  body.spec = {};
  if (input.intervalSeconds !== undefined) {
    body.spec.source = { type: "schedule", schedule: { type: "interval", intervalSeconds: input.intervalSeconds } };
  }
  if (input.status !== undefined) body.spec.suspend = input.status === "paused";
  const template = triggerExecutionSpecUpdate(input);
  const metadata = input.metadata !== undefined ? triggerTemplateMetadata(input.metadata) : undefined;
  if (template || metadata) body.spec.template = { ...(metadata ? { metadata } : {}), ...(template ? { spec: template } : {}) };
  if (Object.keys(body.spec).length === 0) delete body.spec;
  const client = await createAmaClient(env, ownerId, projectId);
  const trigger = await withAmaErrorDetails("update scheduled trigger", () => client.triggers.update(scheduleId, body));
  return toAmaScheduledTrigger(trigger as SdkTrigger);
}

export async function updateAmaHttpAgentTrigger(
  env: Env,
  ownerId: string,
  projectId: string,
  triggerId: string,
  input: AmaHttpTriggerUpdate,
): Promise<AmaHttpTrigger> {
  const body: UpdateTriggerRequest = {};
  if (input.name !== undefined) body.metadata = { name: input.name };
  body.spec = {};
  if (input.status !== undefined) body.spec.suspend = input.status === "paused";
  const template = triggerExecutionSpecUpdate(input);
  const metadata = input.metadata !== undefined ? triggerTemplateMetadata(input.metadata) : undefined;
  if (template || metadata) body.spec.template = { ...(metadata ? { metadata } : {}), ...(template ? { spec: template } : {}) };
  if (Object.keys(body.spec).length === 0) delete body.spec;
  const client = await createAmaClient(env, ownerId, projectId);
  const trigger = await withAmaErrorDetails("update HTTP trigger", () => client.triggers.update(triggerId, body));
  return toAmaHttpTrigger(trigger as SdkTrigger);
}

export async function deleteAmaScheduledAgentTrigger(env: Env, ownerId: string, projectId: string, scheduleId: string): Promise<void> {
  await deleteAmaTrigger(env, ownerId, projectId, scheduleId);
}

export async function deleteAmaTrigger(env: Env, ownerId: string, projectId: string, triggerId: string): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaErrorDetails("delete trigger", () => client.triggers.delete(triggerId));
}

export async function createAmaMemoryStore(env: Env, ownerId: string, input: AmaMemoryStoreInput): Promise<AmaMemoryStore> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const store = await withAmaErrorDetails("create memory store", () =>
    client.memoryStores.create({
      metadata: {
        name: input.name,
        description: input.description ?? null,
      },
      spec: {},
    }),
  );
  return toAmaMemoryStore(store);
}

export async function listAmaMemoryStoreMemories(
  env: Env,
  ownerId: string,
  projectId: string,
  storeId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<AmaListResponse<AmaMemoryStoreMemory>> {
  const client = await createAmaClient(env, ownerId, projectId);
  const page = await withAmaErrorDetails("list memories", () =>
    client.memoryStores.listMemories(storeId, {
      limit: options.limit ?? 100,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    }),
  );
  return { data: page.data.map(toAmaMemoryStoreMemory), pagination: page.pagination };
}

export async function archiveAmaMemoryStore(env: Env, ownerId: string, projectId: string, storeId: string): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaErrorDetails("archive memory store", () => client.memoryStores.update(storeId, { archived: true }));
}

export async function dispatchAmaHttpTriggerRun(env: Env, ownerId: string, input: AmaHttpTriggerRunInput): Promise<AmaTriggerRun> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const run = await withAmaErrorDetails("create HTTP trigger run", () =>
    client.triggers.createRun(input.triggerId, input.body, {
      ...(input.idempotencyKey ? { headers: { "idempotency-key": input.idempotencyKey } } : {}),
    }),
  );
  return toAmaTriggerRun(run as SdkTriggerRun);
}

// Resolves the AMA access token for the linked AMA account of the AK user.
// BetterAuth's generic OAuth refresh path does not forward the resource
// indicator, so AMA refresh is handled here to keep access tokens JWT-shaped for
// AMA's bearer-token validation.
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
  const account = await readAmaLinkedAccount(env.DB, ownerId);
  if (!account) {
    throw new Error(`No linked AMA account for user ${ownerId}; connect AMA to enable cloud scheduling`);
  }

  if (isUsableAmaAccessToken(account.accessToken, account.accessTokenExpiresAt)) {
    return account.accessToken;
  }
  if (!account.refreshToken) {
    throw new AmaLinkedAccountAuthError("AMA linked account has no refresh token. Reconnect AMA in Account settings, then run ak start again.");
  }
  if (isKnownExpired(account.refreshTokenExpiresAt, Date.now())) {
    throw new AmaLinkedAccountAuthError("AMA linked account refresh token is expired. Reconnect AMA in Account settings, then run ak start again.");
  }

  const refreshed = await refreshAmaLinkedAccountToken(env, account.refreshToken);
  await updateAmaLinkedAccountToken(env.DB, account, refreshed);
  return refreshed.accessToken;
}

export function assertAmaAccessToken(accessToken: string): string {
  if (!isSerializedJwt(accessToken)) {
    throw new AmaLinkedAccountAuthError("AMA linked account token is not a JWT. Reconnect AMA in Account settings, then run ak start again.");
  }
  return accessToken;
}

export function isUsableAmaAccessToken(
  accessToken: string | null | undefined,
  expiresAt: string | null | undefined,
  nowMs = Date.now(),
): accessToken is string {
  return Boolean(accessToken && isSerializedJwt(accessToken) && !isExpired(expiresAt, nowMs, AMA_ACCESS_TOKEN_REFRESH_SKEW_MS));
}

function isSerializedJwt(token: string): boolean {
  return token.split(".").length === 3;
}

function isExpired(expiresAt: string | null | undefined, nowMs: number, skewMs: number): boolean {
  if (!expiresAt) return true;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs + skewMs;
}

function isKnownExpired(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs;
}

async function readAmaLinkedAccount(db: Env["DB"], ownerId: string): Promise<AmaLinkedAccountRow | null> {
  return db
    .prepare(
      `SELECT id, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt
       FROM account
       WHERE userId = ? AND providerId = 'ama'
       LIMIT 1`,
    )
    .bind(ownerId)
    .first<AmaLinkedAccountRow>();
}

async function refreshAmaLinkedAccountToken(env: Env, refreshToken: string): Promise<AmaRefreshTokenResult> {
  const tokenEndpoint = await amaOidcTokenEndpoint(env);
  const resource = amaOidcResource(env);
  const body = amaRefreshTokenForm(refreshToken, resource);

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${btoa(`${requireEnv(env.AMA_OIDC_CLIENT_ID, "AMA_OIDC_CLIENT_ID")}:${requireEnv(env.AMA_OIDC_CLIENT_SECRET, "AMA_OIDC_CLIENT_SECRET")}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await response.text();
  const data = parseJsonObject(text);
  if (!response.ok) {
    if (data?.error === "invalid_grant") {
      throw new AmaLinkedAccountAuthError("AMA linked account refresh token is invalid. Reconnect AMA in Account settings, then run ak start again.");
    }
    throw new Error(`AMA OIDC refresh failed with HTTP ${response.status}: ${text}`);
  }
  if (typeof data?.access_token !== "string") {
    throw new Error("AMA OIDC refresh response did not include an access token.");
  }
  const accessToken = assertAmaAccessToken(data.access_token);
  return {
    accessToken,
    ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
    accessTokenExpiresAt: tokenResponseExpiresAt(data),
  };
}

export function amaRefreshTokenForm(refreshToken: string, resource: string | null): URLSearchParams {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (resource) body.set("resource", resource);
  return body;
}

async function amaOidcTokenEndpoint(env: Env): Promise<string> {
  const issuer = requireEnv(env.AMA_OIDC_ISSUER, "AMA_OIDC_ISSUER");
  const response = await fetch(oidcDiscoveryUrl(issuer), { headers: { accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AMA OIDC discovery failed with HTTP ${response.status}: ${text}`);
  }
  const data = parseJsonObject(text);
  if (typeof data?.token_endpoint !== "string") {
    throw new Error("AMA OIDC discovery response did not include a token endpoint.");
  }
  return data.token_endpoint;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function tokenResponseExpiresAt(data: Record<string, unknown>): string | null {
  if (typeof data.expires_at === "number" && Number.isFinite(data.expires_at)) {
    return new Date(data.expires_at * 1000).toISOString();
  }
  if (typeof data.expires_in === "number" && Number.isFinite(data.expires_in)) {
    return new Date(Date.now() + data.expires_in * 1000).toISOString();
  }
  return null;
}

async function updateAmaLinkedAccountToken(db: Env["DB"], account: AmaLinkedAccountRow, token: AmaRefreshTokenResult): Promise<void> {
  await db
    .prepare(
      `UPDATE account
       SET accessToken = ?,
           refreshToken = ?,
           accessTokenExpiresAt = ?,
           updatedAt = datetime('now')
       WHERE id = ?`,
    )
    .bind(token.accessToken, token.refreshToken ?? account.refreshToken, token.accessTokenExpiresAt, account.id)
    .run();
}

function throwIfAmaAuthError(error: unknown): void {
  if (isAmaUnauthorizedError(error)) {
    throw new AmaLinkedAccountAuthError();
  }
}

function isAmaUnauthorizedError(error: unknown): boolean {
  if ((error as { status?: unknown }).status === 401) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\bHTTP 401\b/.test(message) || /authentication required/i.test(message);
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

function toAmaMemoryStoreMemory(memory: SdkMemoryStoreMemory): AmaMemoryStoreMemory {
  return {
    id: memory.metadata.uid,
    storeId: memory.spec.storeId,
    projectId: memory.metadata.projectId ?? "",
    path: memory.spec.path,
    content: memory.spec.content,
    metadata: memory.spec.metadata,
    createdAt: memory.metadata.createdAt,
    updatedAt: memory.metadata.updatedAt,
  };
}
