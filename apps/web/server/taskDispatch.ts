import { generateKeypair, isCloudAgentRuntime, type Task } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { getAgent, updateAgentMetadataAnnotations } from "./agentRepo";
import {
  bindAmaAgentSession,
  closeSession,
  createAmaAgentSession,
  getAmaAgentSession,
  setAmaAgentSessionSecretCredential,
  setAmaAgentSessionUsageTotals,
} from "./agentSessionRepo";
import {
  ensureAmaOwnerIntegration,
  getAmaProjectId,
  resolveAmaCloudEnvironmentId,
  resolveAmaProjectId,
  resolveAmaSessionSecretVaultId,
  upsertAmaOwnerIntegration,
} from "./amaOwnerIntegrationRepo";
import {
  type AmaRunner,
  createAmaAgent,
  createAmaSessionSecret,
  createAmaTaskSession,
  isAmaRuntimeConfigured,
  isAmaTaskDispatchConfigured,
  listAmaRunners,
  readAmaAgent,
  readAmaSession,
  readAmaSessionUsageTotals,
  resolveAmaProviderModelProfile,
  revokeAmaVaultCredential,
  sendAmaSessionMessage,
  stopAmaSession,
  updateAmaAgentConfig,
} from "./amaRuntime";
import type { D1 } from "./db";
import { isGithubAppConfigured, mintGithubInstallationToken } from "./githubApp";
import { createLogger } from "./logger";
import { listMachineEnvironmentCandidatesForRuntime } from "./machineRepo";
import { getSubagent } from "./subagentRepo";
import { computeBlocked } from "./taskDeps";
import { addTaskAction, getTask, releaseTask, updateTask } from "./taskRepo";
import type { Env } from "./types";

type Annotations = Record<string, unknown>;

const logger = createLogger("taskDispatch");

export async function dispatchTaskToAma(
  db: D1,
  env: Env,
  ownerId: string,
  task: Task,
  options: { apiOrigin: string; takeover?: boolean },
): Promise<Task> {
  if (!task.assigned_to || !isAmaTaskDispatchConfigured(env)) {
    return task;
  }

  // Blocked or not-yet-due tasks stay todo+assigned without a runtime binding;
  // the dispatch sweep picks them up once they become runnable.
  if (task.scheduled_at && Date.parse(task.scheduled_at) > Date.now()) return task;
  if ((await computeBlocked(db, [task.id])).has(task.id)) return task;
  // A task whose recent dispatches kept failing is in backoff; skip until it
  // elapses. A deliberate re-assign (takeover) bypasses the backoff.
  if (options.takeover !== true && dispatchBackoffActive(task)) return task;

  const assignedTo = task.assigned_to;
  const amaProjectId = await resolveAmaProjectId(db, env, ownerId);
  const akAgent = await getAgent(db, assignedTo, ownerId);
  if (!akAgent) throw new HTTPException(404, { message: "Assigned agent not found" });
  const amaRuntime = amaRuntimeName(akAgent.runtime);

  // Atomic dispatch claim: the create/assign request and the cron sweep can
  // race on the same task; without the claim both create a session and the
  // later one tears down the earlier one mid-run. Assign requests claim with
  // takeover so a deliberate re-assign can kick an already-bound task, but
  // even a takeover never interrupts a dispatch that is still in flight.
  if (!(await claimTaskDispatch(db, task.id, { takeover: options.takeover === true }))) return task;
  const refreshed = await getTask(db, task.id, ownerId);
  if (!refreshed) return task;
  task = refreshed;

  // Re-dispatch (sweep retry after a failed session) must not leave the
  // previous session running against the same task. This runs before the
  // capacity check on purpose: the old session occupies a runner slot, and
  // tearing it down first is what frees capacity for its replacement on a
  // fully loaded runner. Teardown clears the dispatch claim, so re-claim.
  const staleBinding = taskAnnotations(task);
  if (stringAnnotation(staleBinding, "ama.sessionId") || stringAnnotation(staleBinding, "agentSessionId")) {
    task = await releaseTaskRuntimeBinding(db, env, task);
    if (!(await claimTaskDispatch(db, task.id))) return task;
  }

  let amaEnvironmentId: string;
  if (isCloudAgentRuntime(akAgent.runtime)) {
    // Cloud runtimes run on AMA's sandbox plane: no machine, no runner
    // capacity gate — AMA scales sandboxes per session.
    amaEnvironmentId = await resolveAmaCloudEnvironmentId(db, env, ownerId);
  } else {
    const candidates = await listMachineEnvironmentCandidatesForRuntime(db, ownerId, akAgent.runtime);
    if (candidates.length === 0) {
      throw new HTTPException(409, { message: `Runtime "${akAgent.runtime}" is not available on any machine` });
    }
    const machineRuntime = await firstRunnableCandidate(env, amaProjectId, candidates, amaRuntime, akAgent.model);
    // Capable machines exist but every runner is busy or offline: leave the task
    // queued and let the dispatch sweep retry when capacity frees up.
    if (!machineRuntime) {
      return await annotateTask(db, task, { "ama.dispatch.result": null });
    }
    amaEnvironmentId = machineRuntime.environmentId;
  }
  const amaAgent = await ensureAmaAgentForAkAgent(db, env, ownerId, assignedTo, amaProjectId, amaRuntime);

  const sessionIdentity = await createAkAgentSessionIdentity(db, env, ownerId, assignedTo);
  const vaultId = await resolveAmaSessionSecretVaultId(db, env, ownerId);
  const cloudDispatch = isCloudAgentRuntime(akAgent.runtime);
  const resourceRefs = await taskResourceRefs(db, task);
  const githubTokenSecret = await githubTokenSecretRef(db, env, ownerId, amaProjectId, vaultId, sessionIdentity.sessionId, resourceRefs);
  let secret: Awaited<ReturnType<typeof createAmaSessionSecret>> | null = null;
  let dispatch: Awaited<ReturnType<typeof createAmaTaskSession>> | null = null;
  try {
    secret = await createAmaSessionSecret(env, {
      projectId: amaProjectId,
      vaultId,
      name: secretReferenceName(sessionIdentity.sessionId),
      secretValue: JSON.stringify(sessionIdentity.privateKeyJwk),
      metadata: { purpose: "agent-session" },
    });
    await setAmaAgentSessionSecretCredential(db, sessionIdentity.sessionId, secret.credentialId);

    dispatch = await createAmaTaskSession(env, {
      projectId: amaProjectId,
      agentId: amaAgent.id,
      environmentId: amaEnvironmentId,
      runtime: amaRuntime,
      title: `AK task ${task.id}: ${task.title}`,
      initialPrompt: cloudDispatch ? cloudTaskInitialPrompt(task, resourceRefs) : taskInitialPrompt(task),
      resourceRefs,
      runtimeEnv: {
        AK_WORKER: "1",
        AK_AGENT_ID: assignedTo,
        AK_SESSION_ID: sessionIdentity.sessionId,
        AK_API_URL: apiUrl(env, options.apiOrigin),
        ...agentGitIdentityEnv(akAgent),
      },
      runtimeSecretEnv: [
        { name: "AK_AGENT_KEY", credentialId: secret.credentialId, versionId: secret.activeVersionId },
        ...(githubTokenSecret
          ? [{ name: githubTokenSecret.name, credentialId: githubTokenSecret.credentialId, versionId: githubTokenSecret.versionId }]
          : []),
      ],
    });
    await bindAmaAgentSession(db, sessionIdentity.sessionId, dispatch.sessionId);
  } catch (error) {
    await revokeAkAgentSessionSecret(db, env, sessionIdentity.sessionId).catch((revokeError) => {
      logger.warn(`failed to revoke session secret for ${sessionIdentity.sessionId}: ${revokeError}`);
    });
    await closeSession(db, sessionIdentity.sessionId);
    await recordDispatchFailure(db, task, error).catch(() => {
      // claim cleanup is best-effort; the stale-claim sweep recovers it
    });
    throw error;
  }

  const dispatched = await annotateTask(db, task, {
    "ama.projectId": dispatch.projectId,
    agentId: assignedTo,
    "ama.agentId": amaAgent.id,
    "ama.environmentId": dispatch.environmentId,
    "ama.runtime": amaRuntime,
    "ama.sessionId": dispatch.sessionId,
    agentSessionId: sessionIdentity.sessionId,
    "ama.dispatch.result": "accepted",
    "ama.dispatch.lastReason": null,
    ...(githubTokenSecret?.credentialId ? { "ama.ghCredentialId": githubTokenSecret.credentialId } : {}),
  });
  // Timeline entry last: a crash here leaves the task correctly marked accepted,
  // just missing one cosmetic note (better than a note with no accepted state).
  await addTaskAction(db, task.id, "system", "system", "dispatched", null, sessionIdentity.sessionId);
  return dispatched;
}

export async function ensureAmaAgentForAkAgent(
  db: D1,
  env: Env,
  ownerId: string,
  akAgentId: string,
  projectId: string,
  runtime: string,
  options: { memoryEnabled?: boolean } = {},
) {
  const akAgent = await getAgent(db, akAgentId, ownerId);
  if (!akAgent) throw new HTTPException(404, { message: "Assigned agent not found" });
  const runtimeProfile = resolveAmaProviderModelProfile({
    runtime,
    preferredModel: akAgent.model,
  });
  const subagents = await Promise.all((akAgent.subagents ?? []).map((id) => getSubagent(db, id, ownerId)));
  const amaAgentInput = {
    projectId,
    name: akAgent.name || akAgent.username,
    description: akAgent.bio,
    instructions: akAgent.soul,
    role: akAgent.role,
    provider: runtimeProfile.provider,
    model: runtimeProfile.model,
    skills: akAgent.skills ?? [],
    subagents: subagents.flatMap((subagent) => (subagent ? [amaSubagentProfile(subagent)] : [])),
    capabilityTags: amaAgentCapabilityTags(akAgent.role, akAgent.skills),
    handoffPolicy: amaAgentHandoffPolicy(akAgent.handoff_to),
    metadata: { runtime: runtimeProfile.runtime },
    memoryPolicy: amaAgentMemoryPolicy(options.memoryEnabled === true),
  };
  const annotations = metadataObject(metadataObject(akAgent.metadata).annotations);
  const existingAmaAgentId = stringAnnotation(annotations, "ama.agentId");
  if (existingAmaAgentId) {
    const live = await readAmaAgent(env, projectId, existingAmaAgentId);
    if (live) {
      await updateAmaAgentConfig(env, projectId, live.id, amaAgentInput);
      await updateAgentMetadataAnnotations(db, ownerId, akAgentId, {
        "ama.projectId": projectId,
        "ama.agentId": live.id,
        "ama.provider": runtimeProfile.provider,
        ...(runtimeProfile.model ? { "ama.model": runtimeProfile.model } : { "ama.model": null }),
      });
      return live;
    }
  }

  const agent = await createAmaAgent(env, amaAgentInput);
  await updateAgentMetadataAnnotations(db, ownerId, akAgentId, {
    "ama.projectId": projectId,
    "ama.agentId": agent.id,
    "ama.provider": agent.provider,
    ...(agent.model ? { "ama.model": agent.model } : {}),
  });
  return agent;
}

function amaAgentMemoryPolicy(enabled: boolean) {
  return enabled ? { enabled: true, mode: "notebook", scope: "project_agent" } : { enabled: false };
}

function amaSubagentProfile(subagent: NonNullable<Awaited<ReturnType<typeof getSubagent>>>) {
  return {
    id: subagent.id,
    username: subagent.username,
    name: subagent.name,
    bio: subagent.bio,
    instructions: subagent.soul,
    role: subagent.role,
    modelPreferences: subagent.models ?? [],
    skills: subagent.skills ?? [],
  };
}

function amaAgentCapabilityTags(role: string | null | undefined, skills: string[] | null | undefined) {
  return [...new Set([role, ...(skills ?? []).map((skill) => `skill:${skill}`)].filter((value): value is string => Boolean(value)))];
}

function amaAgentHandoffPolicy(handoffTo: string[] | null | undefined) {
  const roles = (handoffTo ?? []).filter((role) => role.trim().length > 0);
  return roles.length > 0 ? { enabled: true, targets: roles.map((role) => ({ role })) } : {};
}

export function amaRuntimeName(runtime: string): string {
  return runtime === "claude" ? "claude-code" : runtime;
}

// Commits made by the agent carry its AK identity, not the host user's
// (parity with the old daemon's buildAgentEnv).
export function agentGitIdentityEnv(agent: { name?: string | null; username: string }): Record<string, string> {
  const name = agent.name || agent.username;
  const email = `${agent.username}@mails.agent-kanban.dev`;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

export async function getReadyAmaMachineEnvironmentForRuntime(
  db: D1,
  env: Env,
  ownerId: string,
  projectId: string,
  runtime: string,
  model: string | null = null,
): Promise<{ machineId: string; environmentId: string } | null> {
  const candidates = await listMachineEnvironmentCandidatesForRuntime(db, ownerId, runtime);
  return firstRunnableCandidate(env, projectId, candidates, amaRuntimeName(runtime), model);
}

async function firstRunnableCandidate(
  env: Env,
  projectId: string,
  candidates: { machineId: string; environmentId: string }[],
  amaRuntime: string,
  model: string | null,
): Promise<{ machineId: string; environmentId: string } | null> {
  // Prefer an environment whose runner declares the pinned model; keep the
  // first merely runtime-capable environment as a transitional fallback for
  // runners that predate model declarations.
  let fallback: { machineId: string; environmentId: string } | null = null;
  for (const candidate of candidates) {
    const runners = await listAmaRunners(env, projectId, candidate.environmentId);
    const runnable = runners.data.filter((runner) => amaRunnerCanRunRuntime(runner, amaRuntime, model));
    if (runnable.length === 0) continue;
    if (!model || runnable.some((runner) => amaRunnerDeclaresModel(runner, amaRuntime, model))) return candidate;
    fallback ??= candidate;
  }
  return fallback;
}

export function amaRunnerCanRunRuntime(runner: AmaRunner, runtime: string, model: string | null = null): boolean {
  if (runner.status !== "active" || runner.currentLoad >= runner.maxConcurrent || runtimeQuotaExhausted(runner, runtime)) {
    return false;
  }
  const runtimeCapable = runner.capabilities.some(
    (capability) => capability === runtime || capability.startsWith(`runtime-provider-model:${runtime}:`),
  );
  if (!runtimeCapable) return false;
  if (!model) return true;
  // Model-precise gating: a runner declaring specific models only takes tasks
  // pinned to one of them. A bare runtime capability (no model declaration)
  // stays acceptable as a transitional fallback.
  return amaRunnerDeclaresModel(runner, runtime, model) || runner.capabilities.includes(runtime);
}

export function amaRunnerDeclaresModel(runner: AmaRunner, runtime: string, model: string): boolean {
  return runner.capabilities.some((capability) => {
    const declared = amaCapabilityModel(capability, runtime);
    return declared === model || declared === "*";
  });
}

// Capability grammar: runtime-provider-model:<runtime>:<provider>:<model>.
// The model is the remainder after the third colon and may itself contain colons.
export function amaCapabilityModel(capability: string, runtime: string): string | null {
  const prefix = `runtime-provider-model:${runtime}:`;
  if (!capability.startsWith(prefix)) return null;
  const rest = capability.slice(prefix.length);
  const separator = rest.indexOf(":");
  return separator === -1 ? null : rest.slice(separator + 1);
}

// Runners report provider quota windows in their heartbeat usage; dispatching
// to a runtime whose quota is fully used just burns work-item attempts. The
// dispatch sweep retries once the window resets.
function runtimeQuotaExhausted(runner: AmaRunner, runtime: string): boolean {
  const usage = (runner.runtimeUsage ?? []).find((entry) => entry.runtime === runtime);
  if (!usage) return false;
  const now = Date.now();
  // utilization is a 0-100 percentage (bridge normalizes provider scales)
  return usage.windows.some((window) => window.utilization >= 100 && Date.parse(window.resetsAt) > now);
}

export async function sendTaskMessageToAma(env: Env, task: Task, message: string): Promise<Task> {
  const sessionId = amaSessionId(task);
  const projectId = amaProjectId(task);
  if (!sessionId || !projectId || !isAmaRuntimeConfigured(env)) {
    return task;
  }
  await sendAmaSessionMessage(env, projectId, sessionId, message);
  return task;
}

export async function sendTaskRejectToAma(db: D1, env: Env, task: Task, reason: string | undefined): Promise<Task> {
  const sessionId = amaSessionId(task);
  const projectId = amaProjectId(task);
  if (!sessionId || !projectId || !isAmaRuntimeConfigured(env)) {
    return task;
  }
  await sendAmaSessionMessage(
    env,
    projectId,
    sessionId,
    [
      `Task was rejected by reviewer.${reason ? ` Reason: ${reason}` : ""}`,
      "",
      `Resume task ${task.id}. It is already assigned to you and already in progress.`,
      "Do not run `ak task claim` again.",
      "Inspect the current task, repository, and pull request state. Fix the reviewer rejection in the working branch, commit and push any required code changes, rerun the smallest meaningful checks, then submit the task for review again.",
      `When the fix is complete, add a Completion Summary note with what changed and what passed, then run: ak task review ${task.id}`,
    ].join("\n"),
  );
  return await annotateTask(db, task, {
    "ama.lastCommand": "reject_resume",
    "ama.lastCommand.result": "accepted",
  });
}

// Tears down a task's runtime binding: stops the AMA session, revokes the
// session secret, closes the AK agent session, and clears the binding
// annotations so the dispatch sweep can re-dispatch the task later.
export async function releaseTaskRuntimeBinding(
  db: D1,
  env: Env,
  task: Task,
  reason: "user_requested" | "timeout" | "policy" | "runtime_error" = "user_requested",
): Promise<Task> {
  const annotations = taskAnnotations(task);
  const sessionId = stringAnnotation(annotations, "ama.sessionId");
  const projectId = stringAnnotation(annotations, "ama.projectId");
  const akSessionId = stringAnnotation(annotations, "agentSessionId");
  if (!sessionId && !akSessionId) return task;

  if (sessionId && projectId && isAmaRuntimeConfigured(env)) {
    try {
      await stopAmaSession(env, projectId, sessionId, reason);
    } catch (error) {
      // 404: session no longer exists; 409: already archived. Both terminal.
      const status = (error as { status?: unknown }).status;
      if (status !== 404 && status !== 409) throw error;
    }
  }
  if (akSessionId) {
    await collectAkAgentSessionUsage(db, env, akSessionId).catch((error) => {
      logger.warn(`failed to collect session usage for ${akSessionId}: ${error}`);
    });
    await revokeAkAgentSessionSecret(db, env, akSessionId).catch((error) => {
      logger.warn(`failed to revoke session secret for ${akSessionId}: ${error}`);
    });
    const ghCredentialId = stringAnnotation(annotations, "ama.ghCredentialId");
    if (ghCredentialId) {
      // Best effort: the installation token expires within the hour anyway.
      await revokeGithubTokenCredential(db, env, akSessionId, ghCredentialId).catch((error) => {
        logger.warn(`failed to revoke GitHub token credential for ${akSessionId}: ${error}`);
      });
    }
    await closeSession(db, akSessionId);
  }
  return await annotateTask(db, task, {
    "ama.sessionId": null,
    "ama.environmentId": null,
    "ama.dispatch.result": null,
    agentSessionId: null,
    "ama.ghCredentialId": null,
  });
}

async function revokeGithubTokenCredential(db: D1, env: Env, akSessionId: string, credentialId: string): Promise<void> {
  if (!isAmaRuntimeConfigured(env)) return;
  const session = await getAmaAgentSession(db, akSessionId);
  if (!session) return;
  const projectId = await resolveAmaProjectId(db, env, session.owner_id);
  const vaultId = await resolveAmaSessionSecretVaultId(db, env, session.owner_id);
  try {
    await revokeAmaVaultCredential(env, projectId, vaultId, credentialId);
  } catch (error) {
    // 404: credential already gone; 400: already revoked.
    const status = (error as { status?: unknown }).status;
    if (status !== 404 && status !== 400) throw error;
  }
}

// Copies the AMA usage summary for the session into ama_agent_sessions so AK
// session listings show token/cost totals without mirroring AMA event history.
async function collectAkAgentSessionUsage(db: D1, env: Env, akSessionId: string): Promise<void> {
  if (!isAmaRuntimeConfigured(env)) return;
  const session = await getAmaAgentSession(db, akSessionId);
  if (!session?.ama_session_id || session.status !== "active") return;
  const projectId = await getAmaProjectId(db, session.owner_id);
  if (!projectId) return;
  const totals = await readAmaSessionUsageTotals(env, projectId, session.ama_session_id);
  if (totals) await setAmaAgentSessionUsageTotals(db, akSessionId, totals);
}

async function revokeAkAgentSessionSecret(db: D1, env: Env, akSessionId: string): Promise<void> {
  if (!isAmaRuntimeConfigured(env)) return;
  const session = await getAmaAgentSession(db, akSessionId);
  if (!session?.secret_credential_id) return;
  const projectId = await resolveAmaProjectId(db, env, session.owner_id);
  const vaultId = await resolveAmaSessionSecretVaultId(db, env, session.owner_id);
  try {
    await revokeAmaVaultCredential(env, projectId, vaultId, session.secret_credential_id);
  } catch (error) {
    // 404: credential already gone; 400: already revoked.
    const status = (error as { status?: unknown }).status;
    if (status !== 404 && status !== 400) throw error;
  }
  await setAmaAgentSessionSecretCredential(db, akSessionId, null);
}

// Marks the task as being dispatched. The conditional update is the lock:
// only one dispatcher (request or sweep) can flip the annotation to
// "dispatching". A takeover claim may also seize a completed ("accepted")
// dispatch — that is how re-assign kicks an already-bound task — but never
// one that is still in flight.
async function claimTaskDispatch(db: D1, taskId: string, options: { takeover?: boolean } = {}): Promise<boolean> {
  const guard = options.takeover
    ? `(json_extract(metadata, '$.annotations."ama.dispatch.result"') IS NULL
        OR json_extract(metadata, '$.annotations."ama.dispatch.result"') = 'accepted')`
    : `json_extract(metadata, '$.annotations."ama.dispatch.result"') IS NULL`;
  const result = await db
    .prepare(`
      UPDATE tasks SET metadata = json_set(
        json_set(COALESCE(metadata, '{}'), '$.annotations', json(COALESCE(json_extract(metadata, '$.annotations'), '{}'))),
        '$.annotations."ama.dispatch.result"', 'dispatching'
      )
      WHERE id = ? AND ${guard}
    `)
    .bind(taskId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

// A dispatcher that died mid-flight leaves the claim stuck on "dispatching"
// and the task would never be swept again; release claims older than this.
const STALE_DISPATCH_CLAIM_MS = 5 * 60_000;

export async function releaseStaleDispatchClaims(db: D1): Promise<void> {
  const threshold = new Date(Date.now() - STALE_DISPATCH_CLAIM_MS).toISOString();
  const rows = await db
    .prepare(`
      SELECT t.id, b.owner_id FROM tasks t
      JOIN boards b ON t.board_id = b.id
      WHERE t.status = 'todo' AND t.assigned_to IS NOT NULL
        AND json_extract(t.metadata, '$.annotations."ama.dispatch.result"') = 'dispatching'
        AND json_extract(t.metadata, '$.annotations."ama.sessionId"') IS NULL
        AND t.updated_at < ?
    `)
    .bind(threshold)
    .all<{ id: string; owner_id: string }>();
  for (const row of rows.results) {
    const task = await getTask(db, row.id, row.owner_id);
    if (!task) continue;
    await annotateTask(db, task, { "ama.dispatch.result": null });
  }
}

// Cron sweep: dispatch assigned todo tasks that have no runtime binding yet —
// tasks deferred because they were blocked, scheduled in the future, or all
// capable runners were busy, plus tasks released by the reconcile sweep.
export async function dispatchPendingAmaTasks(db: D1, env: Env): Promise<void> {
  if (!isAmaTaskDispatchConfigured(env)) return;
  if (!env.AK_API_URL) {
    logger.warn("AK_API_URL is not set; skipping AMA dispatch sweep");
    return;
  }
  const now = new Date().toISOString();
  const rows = await db
    .prepare(`
      SELECT t.id, b.owner_id FROM tasks t
      JOIN boards b ON t.board_id = b.id
      WHERE t.status = 'todo' AND t.assigned_to IS NOT NULL
        AND json_extract(t.metadata, '$.annotations."ama.dispatch.result"') IS NULL
        AND (t.scheduled_at IS NULL OR t.scheduled_at <= ?)
        AND (json_extract(t.metadata, '$.annotations."ama.dispatch.nextRetryAt"') IS NULL
             OR json_extract(t.metadata, '$.annotations."ama.dispatch.nextRetryAt"') <= ?)
    `)
    .bind(now, now)
    .all<{ id: string; owner_id: string }>();
  for (const row of rows.results) {
    try {
      const task = await getTask(db, row.id, row.owner_id);
      if (!task || task.blocked) continue;
      await dispatchTaskToAma(db, env, row.owner_id, task, { apiOrigin: env.AK_API_URL });
    } catch (error) {
      logger.warn(`dispatch sweep failed for task ${row.id}: ${error}`);
    }
  }
}

const DEAD_AMA_SESSION_STATUSES = new Set(["error", "stopped"]);
// A freshly dispatched task may briefly reference a session AMA has not fully
// materialized; don't treat a 404 as terminal inside this window.
const RECONCILE_MIN_TASK_AGE_MS = 2 * 60_000;
// A session waiting for a runner longer than this has lost its chance (queued
// cloud startup and runner leases both resolve within minutes when healthy).
const STALE_PENDING_SESSION_MS = 10 * 60_000;

// Cron sweep: reconcile AK task state with AMA session state. A session that
// died (runner crash, lease retries exhausted, stopped outside AK) leaves the
// task stranded; release it so the dispatch sweep can re-dispatch. Done and
// cancelled tasks that kept a binding (best-effort cleanup failed during
// complete/cancel) are torn down here.
export async function reconcileAmaBoundTasks(db: D1, env: Env): Promise<void> {
  if (!isAmaRuntimeConfigured(env)) return;
  const rows = await db
    .prepare(`
      SELECT t.id, t.status, b.owner_id FROM tasks t
      JOIN boards b ON t.board_id = b.id
      WHERE t.status IN ('todo', 'in_progress', 'done', 'cancelled')
        AND json_extract(t.metadata, '$.annotations."ama.sessionId"') IS NOT NULL
    `)
    .all<{ id: string; status: string; owner_id: string }>();
  for (const row of rows.results) {
    try {
      const task = await getTask(db, row.id, row.owner_id);
      if (!task) continue;
      if (row.status === "done" || row.status === "cancelled") {
        await releaseTaskRuntimeBinding(db, env, task);
        continue;
      }
      const sessionId = amaSessionId(task);
      const projectId = amaProjectId(task);
      if (!sessionId || !projectId) continue;
      const session = await readAmaSession(env, sessionId, projectId);
      if (!session && Date.parse(task.updated_at) > Date.now() - RECONCILE_MIN_TASK_AGE_MS) continue;
      const status = session ? String(session.state) : null;
      if (status && !DEAD_AMA_SESSION_STATUSES.has(status)) {
        // An idle session on a todo task means the agent's turn ended without
        // claiming (or a release teardown failed mid-way); nothing will resume
        // it, so tear it down and let the dispatch sweep restart the task.
        const idleUnclaimed = row.status === "todo" && status === "idle";
        // A session stuck waiting for a runner (runner offline right after
        // dispatch, capability mismatch) never progresses on its own; release
        // it so the dispatch sweep retries when capacity actually exists.
        const stalePending = status === "pending" && Date.parse(task.updated_at) < Date.now() - STALE_PENDING_SESSION_MS;
        if (!idleUnclaimed && !stalePending) {
          // A live, progressing session means the last dispatch worked; clear
          // any armed re-dispatch backoff so a future failure starts fresh.
          await clearDispatchBackoff(db, task);
          continue;
        }
      }
      const deadReason =
        status === null
          ? "runtime session ended unexpectedly"
          : status === "idle"
            ? "runtime session went idle without being claimed"
            : status === "pending"
              ? "runtime session stuck pending; no runner picked it up"
              : `runtime session ended in state '${status}'`;
      const released = await releaseTaskRuntimeBinding(db, env, task, "runtime_error");
      if (row.status === "in_progress") {
        await releaseTask(db, task.id, "machine", "system", "machine", "released");
      }
      // The session died before the task progressed; arm the backoff so the
      // dispatch sweep does not immediately re-dispatch into the same failure.
      await recordDispatchFailure(db, released, new Error(deadReason));
    } catch (error) {
      logger.warn(`reconcile sweep failed for task ${row.id}: ${error}`);
    }
  }
}

export async function createAkAgentSessionIdentity(db: D1, env: Env, ownerId: string, agentId: string) {
  const sessionId = crypto.randomUUID();
  const keypair = await generateKeypair();
  await createAmaAgentSession(db, env, {
    ownerId,
    agentId,
    sessionId,
    sessionPublicKey: keypair.publicKeyBase64,
  });
  return { sessionId, privateKeyJwk: keypair.privateKeyJwk };
}

async function annotateTask(db: D1, task: Task, values: Annotations) {
  const metadata = metadataObject(task.metadata);
  metadata.annotations = { ...metadataObject(metadata.annotations), ...values };
  const updated = await updateTask(db, task.id, { metadata });
  if (!updated) throw new Error("Task disappeared while storing runtime dispatch metadata");
  return updated;
}

function taskAnnotations(task: Task) {
  return metadataObject(metadataObject(task.metadata).annotations);
}

function amaSessionId(task: Task) {
  return stringAnnotation(taskAnnotations(task), "ama.sessionId");
}

function amaProjectId(task: Task) {
  return stringAnnotation(taskAnnotations(task), "ama.projectId");
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringAnnotation(annotations: Annotations, key: string) {
  const value = annotations[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Re-dispatch backoff: a task whose session keeps dying before it can make
// progress (e.g. a runtime-provider outage) would otherwise be re-dispatched
// every sweep, hammering the provider into a rate-limit cascade. Each failure
// pushes an exponentially-growing nextRetryAt that the dispatch sweep and
// dispatchTaskToAma honor; a healthy run (reconcile sees a live session)
// clears it.
const DISPATCH_BACKOFF_BASE_MS = 30_000;
const DISPATCH_BACKOFF_CAP_MS = 10 * 60_000;

function dispatchBackoffMs(attempts: number): number {
  return Math.min(DISPATCH_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), DISPATCH_BACKOFF_CAP_MS);
}

function dispatchBackoffActive(task: Task): boolean {
  const nextRetryAt = stringAnnotation(taskAnnotations(task), "ama.dispatch.nextRetryAt");
  return nextRetryAt !== null && Date.parse(nextRetryAt) > Date.now();
}

// Records a failed dispatch attempt: clears the binding result and arms the
// backoff. Returns the updated task.
// One-line reason for the task timeline. The wrapped AMA error is
// "AMA <op> failed[ HTTP NNN][: <raw response body>]". Keep the envelope
// (operation + status) and, when the body carries a structured human message,
// append just that field — never the raw response body, which can carry
// internal detail (credential ids, etc.). The raw error stays in the worker logs.
function dispatchErrorReason(error: unknown): string {
  if (error == null) return "dispatch failed";
  const raw = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  const envelope = raw.split(/:\s*[{[]/, 1)[0]?.trim() ?? raw;
  const bodyMessage = raw.match(/"(?:message|detail|error)"\s*:\s*"([^"]{1,160})"/)?.[1];
  const reason = bodyMessage ? `${envelope}: ${bodyMessage}` : envelope;
  return (reason || raw).slice(0, 300) || "unknown error";
}

async function recordDispatchFailure(db: D1, task: Task, error: unknown): Promise<Task> {
  const annotations = taskAnnotations(task);
  const current = annotations["ama.dispatch.attempts"];
  const attempts = (typeof current === "number" ? current : 0) + 1;
  const reason = dispatchErrorReason(error);
  // Dispatch retries with backoff; record one timeline event per DISTINCT reason
  // (not every retry tick) so the task timeline shows "stuck dispatching, because X"
  // without flooding it.
  if (annotations["ama.dispatch.lastReason"] !== reason) {
    await addTaskAction(db, task.id, "system", "system", "dispatch_failed", reason, null);
  }
  return await annotateTask(db, task, {
    "ama.dispatch.result": null,
    "ama.dispatch.attempts": attempts,
    "ama.dispatch.lastReason": reason,
    "ama.dispatch.nextRetryAt": new Date(Date.now() + dispatchBackoffMs(attempts)).toISOString(),
  });
}

async function clearDispatchBackoff(db: D1, task: Task): Promise<void> {
  const attempts = taskAnnotations(task)["ama.dispatch.attempts"];
  if (attempts === undefined || attempts === null) return;
  await annotateTask(db, task, { "ama.dispatch.attempts": null, "ama.dispatch.nextRetryAt": null });
}

function taskInitialPrompt(task: Task) {
  const prompt = [
    `You are assigned AK task ${task.id}: ${task.title}`,
    task.description ? `Task detail:\n${task.description}` : null,
    "Use the AK CLI/API for workflow state. First run:",
    `ak task claim ${task.id}`,
    "Inspect the task with:",
    `ak describe task ${task.id}`,
    "When the work is complete, submit for review with `ak task review` and a PR URL when applicable.",
  ].filter(Boolean);
  return prompt.join("\n");
}

// Cloud sandboxes have no AK skill install and no gh CLI: the prompt has to
// carry the whole workflow, step by step, for the sandbox-hosted agent.
function cloudTaskInitialPrompt(task: Task, resourceRefs: { owner: string; repo: string }[]) {
  const repo = resourceRefs[0] ?? null;
  // AMA normalizes github_repository mounts to /workspace/repos/{owner}/{repo}.
  const repoDir = repo ? `/workspace/repos/${repo.owner}/${repo.repo}` : null;
  const branch = `ak/${task.id}`;
  const prompt = [
    `You are assigned AK task ${task.id}: ${task.title}`,
    task.description ? `Task detail:\n${task.description}` : null,
    "",
    "You work inside a cloud sandbox. Run every shell command with the sandbox.exec tool. Environment variables (AK_*, GH_TOKEN, GIT_*) are already set for those commands.",
    repo ? `The repository ${repo.owner}/${repo.repo} is already cloned at ${repoDir}; git push credentials are preconfigured.` : null,
    "",
    "Follow these steps in order, one sandbox.exec command at a time:",
    // npm is unusable inside the sandbox (orphaned workers hang the exec
    // pipe), so the CLI ships as a single-file bundle served by this server.
    `1. Install the AK CLI: curl -fsS "$AK_API_URL/cli/install.sh" | sh`,
    `2. Claim the task: ak task claim ${task.id}`,
    ...(repo && repoDir
      ? [
          `3. Note the default branch: git -C ${repoDir} branch --show-current`,
          `4. Create a work branch: git -C ${repoDir} checkout -b ${branch}`,
          "5. Do the work described in the task detail (edit files under the repository).",
          `6. Commit and push: git -C ${repoDir} add -A && git -C ${repoDir} commit -m "<summary>" && git -C ${repoDir} push -u origin ${branch}`,
          `7. Create a pull request (replace <base> with the default branch from step 3): gh pr create --repo ${repo.owner}/${repo.repo} --head ${branch} --base <base> --title "${task.title.replaceAll('"', "'")}" --body "AK task ${task.id}" — the command prints the PR URL.`,
          `8. Submit for review: ak task review ${task.id} --pr-url <PR URL>`,
        ]
      : ["3. Do the work described in the task detail.", `4. Submit for review: ak task review ${task.id}`]),
  ].filter((line): line is string => line !== null);
  return prompt.join("\n");
}

// The GitHub credential sessions push with. Preferred source: a
// repository-scoped ~1h GitHub App installation token minted per session and
// revoked at binding teardown. Fallback: the server-level GITHUB_AGENT_TOKEN
// stored once per owner in the AMA vault.
async function githubTokenSecretRef(
  db: D1,
  env: Env,
  ownerId: string,
  projectId: string,
  vaultId: string,
  akSessionId: string,
  resourceRefs: { owner: string; repo: string }[],
): Promise<{ name: string; credentialId: string; versionId?: string | null } | null> {
  const repo = resourceRefs[0];
  if (repo && isGithubAppConfigured(env)) {
    try {
      const minted = await mintGithubInstallationToken(env, repo.owner, repo.repo);
      const secret = await createAmaSessionSecret(env, {
        projectId,
        vaultId,
        name: `GH_TOKEN_${akSessionId.replaceAll(/[^A-Za-z0-9_]/g, "_")}`,
        secretValue: minted.token,
        metadata: { purpose: "github-installation-token", repository: `${repo.owner}/${repo.repo}`, expiresAt: minted.expiresAt },
      });
      return { name: "GH_TOKEN", credentialId: secret.credentialId, versionId: secret.activeVersionId };
    } catch (error) {
      logger.warn(`GitHub App token minting failed for ${repo.owner}/${repo.repo}, falling back: ${error}`);
    }
  }
  return await ownerGithubTokenSecretRef(db, env, ownerId, projectId, vaultId);
}

async function ownerGithubTokenSecretRef(
  db: D1,
  env: Env,
  ownerId: string,
  projectId: string,
  vaultId: string,
): Promise<{ name: string; credentialId: string; versionId?: string | null } | null> {
  if (!env.GITHUB_AGENT_TOKEN) return null;
  const integration = await ensureAmaOwnerIntegration(db, env, ownerId);
  const existingCredentialId = integration.metadata.githubTokenSecretCredentialId;
  const existingVersionId = integration.metadata.githubTokenSecretVersionId;
  if (typeof existingCredentialId === "string" && existingCredentialId) {
    return {
      name: "GH_TOKEN",
      credentialId: existingCredentialId,
      versionId: typeof existingVersionId === "string" ? existingVersionId : null,
    };
  }
  const secret = await createAmaSessionSecret(env, {
    projectId,
    vaultId,
    name: "GH_AGENT_TOKEN",
    secretValue: env.GITHUB_AGENT_TOKEN,
    metadata: { purpose: "github-agent-token" },
  });
  await upsertAmaOwnerIntegration(db, {
    ownerId,
    amaProjectId: integration.amaProjectId,
    externalTenantId: integration.externalTenantId,
    sessionSecretVaultId: integration.sessionSecretVaultId,
    metadata: { ...integration.metadata, githubTokenSecretCredentialId: secret.credentialId, githubTokenSecretVersionId: secret.activeVersionId },
  });
  return { name: "GH_TOKEN", credentialId: secret.credentialId, versionId: secret.activeVersionId };
}

async function taskResourceRefs(db: D1, task: Task) {
  if (!task.repository_id) return [];
  const repo = await db.prepare("SELECT url FROM repositories WHERE id = ?").bind(task.repository_id).first<{ url: string }>();
  const github = repo ? githubRepoRef(repo.url) : null;
  return github ? [github] : [];
}

export function githubRepoRef(url: string) {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) return null;
  return { type: "github_repository", owner: match[1], repo: match[2] };
}

export function secretReferenceName(sessionId: string) {
  return `AK_AGENT_KEY_${sessionId.replaceAll(/[^A-Za-z0-9_]/g, "_")}`;
}

export function apiUrl(env: Env, requestOrigin: string) {
  return env.AK_API_URL ?? requestOrigin;
}
