import { AmaClient } from "@any-managed-agents/sdk";
import type { Env } from "./types";

export type AmaResourceRef = Record<string, unknown>;
export interface AmaRuntimeSecretEnvRef {
  name: string;
  ref: string;
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
  environmentId: string;
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
  environmentId: string;
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

export interface AmaSessionRuntimeSnapshot {
  taskSessionId: string;
  session: Record<string, unknown>;
  events: Record<string, unknown>[];
  pagination: Record<string, unknown>;
}

export interface AmaListResponse<T> {
  data: T[];
  pagination?: Record<string, unknown>;
}

interface AmaSessionResponse {
  id: string;
  agentId: string;
  environmentId: string | null;
  status: string;
  statusReason: string | null;
}

interface AmaCredentialResponse {
  id: string;
  activeVersionId: string | null;
}

interface AmaAgentResponse {
  id: string;
  projectId: string;
  name: string;
  provider: string;
  model: string | null;
}

interface AmaEnvironmentResponse {
  id: string;
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

interface AmaProviderResponse {
  id: string;
  type?: string | null;
  status?: string | null;
}

interface AmaProviderConfigResponse {
  id: string;
  type: string;
  status?: string | null;
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

export interface AmaExternalBindingInput {
  projectId: string;
  issuer: string;
  externalTenantId: string;
  environmentId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AmaRunnerTokenInput {
  projectId: string;
  issuer: string;
  externalTenantId: string;
  subject: string;
  environmentId: string;
}

export interface AmaRunnerToken {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number | null;
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

const RUNTIME_PROVIDER_PROFILES: Record<
  string,
  {
    providerType: string;
    providerDisplayName: string;
  }
> = {
  "claude-code": {
    providerType: "anthropic",
    providerDisplayName: "Anthropic",
  },
  codex: {
    providerType: "openai",
    providerDisplayName: "OpenAI",
  },
  copilot: {
    providerType: "other",
    providerDisplayName: "GitHub Copilot",
  },
};

export function isAmaRuntimeConfigured(env: Env): boolean {
  return Boolean(env.AMA_ORIGIN && hasTokenSource(env));
}

export function isAmaTaskDispatchConfigured(env: Env): boolean {
  return isAmaRuntimeConfigured(env);
}

export async function createAmaTaskSession(env: Env, input: AmaTaskSessionInput): Promise<AmaSessionDispatch> {
  const client = await createAmaClient(env, input.projectId);
  const session = await withAmaErrorDetails("create session", () =>
    client.request<AmaSessionResponse>("createSession", {
      body: {
        agentId: input.agentId,
        environmentId: input.environmentId,
        runtime: input.runtime,
        title: input.title,
        resourceRefs: input.resourceRefs ?? [],
        ...(input.runtimeEnv ? { runtimeEnv: input.runtimeEnv } : {}),
        ...(input.runtimeSecretEnv ? { runtimeSecretEnv: input.runtimeSecretEnv } : {}),
        ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
      },
    }),
  );

  return {
    projectId: input.projectId,
    agentId: session.agentId,
    environmentId: session.environmentId ?? input.environmentId,
    sessionId: session.id,
    status: session.status,
    statusReason: session.statusReason,
  };
}

export async function createAmaAgent(env: Env, input: AmaAgentInput): Promise<AmaAgent> {
  const client = await createAmaClient(env, input.projectId);
  const agent = await withAmaErrorDetails("create runtime agent", () =>
    client.request<AmaAgentResponse>("createAgent", {
      body: {
        name: input.name,
        description: input.description ?? null,
        instructions: input.instructions ?? null,
        systemPrompt: input.instructions ?? null,
        provider: input.provider,
        ...(input.model ? { model: input.model } : {}),
        ...(input.role ? { role: input.role } : {}),
        skills: input.skills ?? [],
        subagents: input.subagents ?? [],
        capabilityTags: input.capabilityTags ?? [],
        handoffPolicy: input.handoffPolicy ?? {},
        metadata: input.metadata ?? {},
        memoryPolicy: input.memoryPolicy ?? { enabled: false },
      },
    }),
  );
  return {
    id: agent.id,
    projectId: agent.projectId,
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
  };
}

export async function createAmaProject(env: Env, input: { name: string }): Promise<AmaProject> {
  const client = await createAmaClient(env);
  const project = await withAmaErrorDetails("create project", () =>
    client.request<{ id: string; name: string }>("createProject", { body: { name: input.name } }),
  );
  return { id: project.id, name: project.name };
}

export async function createAmaVault(env: Env, input: AmaVaultInput): Promise<AmaVault> {
  const client = await createAmaClient(env, input.projectId);
  const vault = await withAmaErrorDetails("create vault", () =>
    client.request<{ id: string }>("createVault", {
      body: {
        name: input.name,
        description: input.description,
        scope: input.scope,
        metadata: input.metadata ?? {},
      },
    }),
  );
  return { id: vault.id };
}

export async function createAmaEnvironment(env: Env, input: AmaEnvironmentInput): Promise<AmaEnvironment> {
  const client = await createAmaClient(env, input.projectId);
  const environment = await withAmaErrorDetails("create environment", () =>
    client.request<AmaEnvironmentResponse>("createEnvironment", {
      body: {
        name: input.name,
        description: input.description,
        hostingMode: input.hostingMode,
        metadata: input.metadata ?? {},
      },
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

export async function readAmaAgent(env: Env, projectId: string, agentId: string): Promise<AmaAgent | null> {
  const client = await createAmaClient(env, projectId);
  try {
    const agent = await client.request<AmaAgentResponse>("readAgent", { path: { agentId } });
    return {
      id: agent.id,
      projectId: agent.projectId,
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
    };
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

export async function updateAmaAgentConfig(env: Env, projectId: string, agentId: string, input: AmaAgentInput): Promise<void> {
  const client = await createAmaClient(env, projectId);
  await withAmaErrorDetails("update runtime agent config", () =>
    client.request("updateAgent", {
      path: { agentId },
      body: {
        name: input.name,
        description: input.description ?? null,
        instructions: input.instructions ?? null,
        systemPrompt: input.instructions ?? null,
        provider: input.provider,
        model: input.model ?? null,
        role: input.role ?? null,
        skills: input.skills ?? [],
        subagents: input.subagents ?? [],
        capabilityTags: input.capabilityTags ?? [],
        handoffPolicy: input.handoffPolicy ?? {},
        metadata: input.metadata ?? {},
        memoryPolicy: input.memoryPolicy ?? { enabled: false },
      },
    }),
  );
}

export async function readAmaEnvironment(env: Env, projectId: string, environmentId: string): Promise<AmaEnvironment> {
  const client = await createAmaClient(env, projectId);
  const environment = await client.request<AmaEnvironmentResponse>("readEnvironment", { path: { environmentId } });
  return { id: environment.id };
}

export async function resolveAmaProviderModelProfile(
  env: Env,
  projectId: string,
  input: { runtime: string; preferredModel?: string | null },
): Promise<AmaProviderModelProfile> {
  return await ensureAmaProviderModelProfile(env, projectId, input.runtime, input.preferredModel);
}

async function ensureAmaProviderModelProfile(
  env: Env,
  projectId: string,
  runtime: string,
  preferredModel?: string | null,
): Promise<AmaProviderModelProfile> {
  const configured = RUNTIME_PROVIDER_PROFILES[runtime];
  if (!configured) {
    throw new Error(`No AK runtime provider mapping is configured for runtime ${runtime}`);
  }
  const client = await createAmaClient(env, projectId);
  const providers = await client.request<AmaListResponse<AmaProviderResponse>>("listProviders", {
    query: { limit: 100 },
  });
  let provider = providers.data.find((item) => item.type === configured.providerType && item.status !== "disabled" && item.status !== "deleted");
  if (!provider) {
    provider = await withAmaErrorDetails("create provider", () =>
      client.request<AmaProviderConfigResponse>("createProvider", {
        body: {
          type: configured.providerType,
          displayName: configured.providerDisplayName,
          metadata: { runtime },
        },
      }),
    );
  }

  const model = preferredModel ?? null;
  if (model) {
    await withAmaErrorDetails("upsert provider model", () =>
      client.request("upsertProviderModel", {
        path: { providerId: provider.id },
        body: {
          modelId: model,
          displayName: model,
          capabilities: ["text"],
          availability: "available",
          metadata: { runtime },
        },
      }),
    );
  }

  return { runtime, provider: provider.id, model };
}

export async function createAmaExternalProjectBinding(env: Env, input: AmaExternalBindingInput): Promise<void> {
  const client = await createAmaClient(env, input.projectId);
  try {
    await client.request("createExternalProjectBinding", {
      path: { projectId: input.projectId },
      body: {
        issuer: input.issuer,
        externalTenantId: input.externalTenantId,
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    });
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? ` HTTP ${(error as { status: number }).status}` : "";
    const responseText =
      typeof (error as { responseText?: unknown }).responseText === "string" ? `: ${(error as { responseText: string }).responseText}` : "";
    throw new Error(`AMA external project binding failed${status}${responseText}`);
  }
}

export async function createAmaFederatedRunnerToken(env: Env, input: AmaRunnerTokenInput): Promise<AmaRunnerToken> {
  const tokenUrl = requireEnv(env.AMA_OAUTH_TOKEN_URL, "AMA_OAUTH_TOKEN_URL");
  const clientId = requireEnv(env.AMA_OAUTH_CLIENT_ID, "AMA_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv(env.AMA_OAUTH_CLIENT_SECRET, "AMA_OAUTH_CLIENT_SECRET");
  const audience = requireEnv(env.AMA_ORIGIN, "AMA_ORIGIN").replace(/\/$/, "");
  const issuer = input.issuer.replace(/\/$/, "");
  const subjectSecret = requireEnv(env.AK_FEDERATED_RUNNER_SUBJECT_SECRET, "AK_FEDERATED_RUNNER_SUBJECT_SECRET");
  const subjectToken = await signSubjectToken(subjectSecret, {
    iss: issuer,
    sub: `${input.externalTenantId}:${input.subject}`,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 120,
    external_tenant_id: input.externalTenantId,
    ama_environment_id: input.environmentId,
  });
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: subjectToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    audience,
    scope: "runner:connect offline_access",
  });
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AMA token exchange failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const token = (await response.json()) as OAuthTokenResponse;
  if (!token.access_token) {
    throw new Error("AMA token exchange response did not include access_token");
  }
  if (!token.refresh_token) {
    throw new Error("AMA token exchange response did not include refresh_token");
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    tokenType: token.token_type ?? "Bearer",
    expiresIn: token.expires_in ?? null,
  };
}

export async function createAmaSessionSecret(env: Env, input: AmaSessionSecretInput): Promise<AmaSessionSecret> {
  const client = await createAmaClient(env, input.projectId);
  const credential = await client.request<AmaCredentialResponse>("createVaultCredential", {
    path: { vaultId: input.vaultId },
    body: {
      name: input.name,
      type: "session_env_secret",
      metadata: input.metadata ?? {},
      secret: {
        provider: "ama-managed",
        secretValue: input.secretValue,
        referenceName: input.name,
      },
    },
  });
  if (!credential.activeVersionId) {
    throw new Error("AMA vault credential response did not include activeVersionId");
  }
  return { credentialId: credential.id, activeVersionId: credential.activeVersionId };
}

export async function sendAmaSessionMessage(env: Env, projectId: string, sessionId: string, message: string): Promise<AmaRuntimeCommandResult> {
  const client = await createAmaClient(env, projectId);
  const result = await client.request<{ accepted?: boolean }>("createSessionCommand", {
    path: { sessionId },
    body: { type: "prompt", message },
  });
  return { accepted: result.accepted !== false };
}

export interface AmaSessionEventsQuery {
  cursor?: number;
  order?: "asc" | "desc";
  limit?: number;
}

export async function getAmaSessionRuntimeSnapshot(
  env: Env,
  sessionId: string,
  projectId?: string,
  events: AmaSessionEventsQuery = {},
): Promise<AmaSessionRuntimeSnapshot> {
  const client = await createAmaClient(env, projectId);
  const eventQuery: Record<string, string | number | boolean | undefined> = { limit: events.limit ?? 100, order: events.order ?? "asc" };
  if (events.cursor !== undefined) eventQuery.cursor = events.cursor;
  const [session, eventPage] = await Promise.all([
    client.request<Record<string, unknown>>("readSession", { path: { sessionId } }),
    client.request<{ data: Record<string, unknown>[]; pagination: Record<string, unknown> }>("listSessionEvents", {
      path: { sessionId },
      query: eventQuery,
    }),
  ]);
  return {
    taskSessionId: sessionId,
    session,
    events: eventPage.data,
    pagination: eventPage.pagination,
  };
}

export async function readAmaSession(env: Env, sessionId: string, projectId?: string): Promise<Record<string, unknown> | null> {
  const client = await createAmaClient(env, projectId);
  try {
    return await client.request<Record<string, unknown>>("readSession", { path: { sessionId } });
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

export async function listAmaAgents(env: Env): Promise<AmaListResponse<Record<string, unknown>>> {
  const client = await createAmaClient(env);
  return await client.request<AmaListResponse<Record<string, unknown>>>("listAgents", {
    query: { limit: 100 },
  });
}

export async function listAmaEnvironments(env: Env): Promise<AmaListResponse<Record<string, unknown>>> {
  const client = await createAmaClient(env);
  return await client.request<AmaListResponse<Record<string, unknown>>>("listEnvironments", {
    query: { limit: 100 },
  });
}

export async function listAmaRunners(env: Env, projectId: string, environmentId: string): Promise<AmaListResponse<AmaRunner>> {
  const client = await createAmaClient(env, projectId);
  return await client.request<AmaListResponse<AmaRunner>>("listRunners", {
    query: { environmentId, limit: 100 },
  });
}

export async function listAmaScheduledTriggerRuns(
  env: Env,
  projectId: string,
  triggerId: string,
  options: { limit?: number } = {},
): Promise<AmaListResponse<AmaScheduledTriggerRun>> {
  const client = await createAmaClient(env, projectId);
  return await client.request<AmaListResponse<AmaScheduledTriggerRun>>("listScheduledTriggerRuns", {
    path: { triggerId },
    query: { limit: options.limit ?? 20 },
  });
}

export async function stopAmaSession(
  env: Env,
  projectId: string,
  sessionId: string,
  reason: "user_requested" | "timeout" | "policy" | "runtime_error",
) {
  const client = await createAmaClient(env, projectId);
  await client.request("stopSession", { path: { sessionId }, query: { reason } });
}

export async function createAmaScheduledAgentTrigger(env: Env, input: AmaScheduledTriggerInput): Promise<AmaScheduledTrigger> {
  const client = await createAmaClient(env, input.projectId);
  return await client.request<AmaScheduledTrigger>("createScheduledAgentTrigger", {
    body: {
      agentId: input.agentId,
      environmentId: input.environmentId,
      runtime: input.runtime,
      name: input.name,
      promptTemplate: input.promptTemplate,
      resourceRefs: input.resourceRefs ?? [],
      runtimeEnv: input.runtimeEnv ?? {},
      runtimeSecretEnv: input.runtimeSecretEnv ?? [],
      schedule: { type: "interval", intervalSeconds: input.intervalSeconds },
      status: input.status ?? "active",
    },
  });
}

export async function updateAmaScheduledAgentTrigger(
  env: Env,
  projectId: string,
  scheduleId: string,
  input: AmaScheduledTriggerUpdate,
): Promise<AmaScheduledTrigger> {
  const body: Record<string, unknown> = {};
  if (input.agentId !== undefined) body.agentId = input.agentId;
  if (input.environmentId !== undefined) body.environmentId = input.environmentId;
  if (input.runtime !== undefined) body.runtime = input.runtime;
  if (input.name !== undefined) body.name = input.name;
  if (input.promptTemplate !== undefined) body.promptTemplate = input.promptTemplate;
  if (input.intervalSeconds !== undefined) body.schedule = { type: "interval", intervalSeconds: input.intervalSeconds };
  if (input.status !== undefined) body.status = input.status;
  const client = await createAmaClient(env, projectId);
  return await client.request<AmaScheduledTrigger>("updateScheduledAgentTrigger", {
    path: { triggerId: scheduleId },
    body,
  });
}

export async function archiveAmaScheduledAgentTrigger(env: Env, projectId: string, scheduleId: string): Promise<void> {
  const client = await createAmaClient(env, projectId);
  await client.request("archiveScheduledAgentTrigger", { path: { triggerId: scheduleId } });
}

async function createAmaClient(env: Env, projectId?: string) {
  return new AmaClient({
    origin: requireEnv(env.AMA_ORIGIN, "AMA_ORIGIN"),
    accessToken: await accessToken(env),
    projectId,
  });
}

// The client-credentials token is valid for ~1h; cache it per isolate so each
// AMA call doesn't pay a second remote round-trip re-authenticating. Keyed by
// client id so a credential change invalidates the cache.
let cachedAmaToken: { key: string; token: string; expiresAt: number } | null = null;
const AMA_TOKEN_REFRESH_SKEW_MS = 60_000;

async function accessToken(env: Env) {
  const tokenUrl = requireEnv(env.AMA_OAUTH_TOKEN_URL, "AMA_OAUTH_TOKEN_URL");
  const clientId = requireEnv(env.AMA_OAUTH_CLIENT_ID, "AMA_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv(env.AMA_OAUTH_CLIENT_SECRET, "AMA_OAUTH_CLIENT_SECRET");
  if (cachedAmaToken && cachedAmaToken.key === clientId && cachedAmaToken.expiresAt > Date.now()) {
    return cachedAmaToken.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (env.AMA_OAUTH_SCOPE) {
    body.set("scope", env.AMA_OAUTH_SCOPE);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`AMA OAuth token request failed with HTTP ${response.status}`);
  }
  const token = (await response.json()) as OAuthTokenResponse;
  if (!token.access_token) {
    throw new Error("AMA OAuth token response did not include access_token");
  }
  const ttlMs = Math.max((token.expires_in ?? 3600) * 1000 - AMA_TOKEN_REFRESH_SKEW_MS, 30_000);
  cachedAmaToken = { key: clientId, token: token.access_token, expiresAt: Date.now() + ttlMs };
  return token.access_token;
}

function hasTokenSource(env: Env) {
  return Boolean(env.AMA_OAUTH_TOKEN_URL && env.AMA_OAUTH_CLIENT_ID && env.AMA_OAUTH_CLIENT_SECRET);
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function signSubjectToken(secret: string, payload: Record<string, unknown>) {
  const header = base64UrlString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlString(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${base64Url(new Uint8Array(signature))}`;
}

function base64UrlString(value: string) {
  return base64Url(new TextEncoder().encode(value));
}

function base64Url(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
