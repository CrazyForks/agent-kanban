import { generateKeypair, type Task } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { getAgent, updateAgentMetadataAnnotations } from "./agentRepo";
import { bindAmaAgentSession, closeSession, createAmaAgentSession } from "./agentSessionRepo";
import { resolveAmaProjectId, resolveAmaSessionSecretVaultId } from "./amaOwnerIntegrationRepo";
import {
  type AmaRunner,
  createAmaAgent,
  createAmaSessionSecret,
  createAmaTaskSession,
  isAmaRuntimeConfigured,
  isAmaTaskDispatchConfigured,
  listAmaRunners,
  readAmaAgent,
  resolveAmaProviderModelProfile,
  sendAmaSessionMessage,
  stopAmaSession,
} from "./amaRuntime";
import type { D1 } from "./db";
import { listMachineEnvironmentCandidatesForRuntime } from "./machineRepo";
import { updateTask } from "./taskRepo";
import type { Env } from "./types";

type Annotations = Record<string, unknown>;

export async function dispatchTaskToAma(db: D1, env: Env, ownerId: string, task: Task, options: { apiOrigin: string }): Promise<Task> {
  if (!task.assigned_to || !isAmaTaskDispatchConfigured(env)) {
    return task;
  }

  const amaProjectId = await resolveAmaProjectId(db, env, ownerId);
  const akAgent = await getAgent(db, task.assigned_to, ownerId);
  if (!akAgent) throw new HTTPException(404, { message: "Assigned agent not found" });
  const amaRuntime = amaRuntimeName(akAgent.runtime);
  const machineRuntime = await getReadyAmaMachineEnvironmentForRuntime(db, env, ownerId, amaProjectId, akAgent.runtime);
  if (!machineRuntime) throw new HTTPException(409, { message: `Runtime "${akAgent.runtime}" is not available on any active AMA environment` });
  const amaEnvironmentId = machineRuntime.environmentId;
  const amaAgent = await ensureAmaAgentForAkAgent(db, env, ownerId, task.assigned_to, amaProjectId, amaRuntime);

  const sessionIdentity = await createAkAgentSessionIdentity(db, env, ownerId, task.assigned_to);
  const vaultId = await resolveAmaSessionSecretVaultId(db, env, ownerId);
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

    dispatch = await createAmaTaskSession(env, {
      projectId: amaProjectId,
      agentId: amaAgent.id,
      environmentId: amaEnvironmentId,
      runtime: amaRuntime,
      title: `AK task ${task.id}: ${task.title}`,
      initialPrompt: taskInitialPrompt(task),
      resourceRefs: await taskResourceRefs(db, task),
      runtimeEnv: {
        AK_WORKER: "1",
        AK_AGENT_ID: task.assigned_to,
        AK_SESSION_ID: sessionIdentity.sessionId,
        AK_API_URL: apiUrl(env, options.apiOrigin),
      },
      runtimeSecretEnv: [{ name: "AK_AGENT_KEY", ref: secret.activeVersionId }],
    });
    await bindAmaAgentSession(db, sessionIdentity.sessionId, dispatch.sessionId);
  } catch (error) {
    await closeSession(db, sessionIdentity.sessionId);
    throw error;
  }

  return await annotateTask(db, task, {
    "ama.projectId": dispatch.projectId,
    agentId: task.assigned_to,
    "ama.agentId": amaAgent.id,
    "ama.environmentId": dispatch.environmentId,
    "ama.runtime": amaRuntime,
    "ama.sessionId": dispatch.sessionId,
    "ama.session.status": dispatch.status,
    "ama.session.statusReason": dispatch.statusReason,
    "ama.runtimeSecretEnv.AK_AGENT_KEY": secret.activeVersionId,
    agentSessionId: sessionIdentity.sessionId,
    "ama.dispatch.result": "accepted",
  });
}

export async function ensureAmaAgentForAkAgent(db: D1, env: Env, ownerId: string, akAgentId: string, projectId: string, runtime: string) {
  const akAgent = await getAgent(db, akAgentId, ownerId);
  if (!akAgent) throw new HTTPException(404, { message: "Assigned agent not found" });
  const annotations = metadataObject(metadataObject(akAgent.metadata).annotations);
  const existingAmaAgentId = stringAnnotation(annotations, "ama.agentId");
  if (existingAmaAgentId) {
    const live = await readAmaAgent(env, projectId, existingAmaAgentId);
    if (live) return live;
  }

  const runtimeProfile = await resolveAmaProviderModelProfile(env, projectId, {
    runtime,
    preferredModel: akAgent.model,
  });
  const agent = await createAmaAgent(env, {
    projectId,
    name: akAgent.name || akAgent.username,
    description: akAgent.bio,
    instructions: akAgent.soul,
    role: akAgent.role,
    provider: runtimeProfile.provider,
    model: runtimeProfile.model,
    metadata: { runtime: runtimeProfile.runtime },
  });
  await updateAgentMetadataAnnotations(db, ownerId, akAgentId, {
    "ama.projectId": projectId,
    "ama.agentId": agent.id,
    "ama.provider": agent.provider,
    "ama.model": agent.model,
  });
  return agent;
}

export function amaRuntimeName(runtime: string): string {
  return runtime === "claude" ? "claude-code" : runtime;
}

export async function getReadyAmaMachineEnvironmentForRuntime(
  db: D1,
  env: Env,
  ownerId: string,
  projectId: string,
  runtime: string,
): Promise<{ machineId: string; environmentId: string } | null> {
  const amaRuntime = amaRuntimeName(runtime);
  const candidates = await listMachineEnvironmentCandidatesForRuntime(db, ownerId, runtime);
  for (const candidate of candidates) {
    const runners = await listAmaRunners(env, projectId, candidate.environmentId);
    if (runners.data.some((runner) => amaRunnerCanRunRuntime(runner, amaRuntime))) {
      return candidate;
    }
  }
  return null;
}

function amaRunnerCanRunRuntime(runner: AmaRunner, runtime: string): boolean {
  return (
    runner.status === "active" &&
    runner.currentLoad < runner.maxConcurrent &&
    runner.capabilities.some((capability) => capability === runtime || capability.startsWith(`runtime-provider-model:${runtime}:`))
  );
}

export async function sendTaskMessageToAma(env: Env, task: Task, message: string): Promise<Task> {
  const sessionId = amaSessionId(task);
  if (!sessionId || !isAmaRuntimeConfigured(env)) {
    return task;
  }
  await sendAmaSessionMessage(env, sessionId, message);
  return task;
}

export async function sendTaskRejectToAma(db: D1, env: Env, task: Task, reason: string | undefined): Promise<Task> {
  const sessionId = amaSessionId(task);
  if (!sessionId || !isAmaRuntimeConfigured(env)) {
    return task;
  }
  await sendAmaSessionMessage(
    env,
    sessionId,
    [
      `Task was rejected by reviewer.${reason ? ` Reason: ${reason}` : ""}`,
      "",
      `Resume task ${task.id}. It is already assigned to you and already in progress.`,
      "Do not inspect files. Do not run tests. Do not run help commands. Do not run `ak task claim` again.",
      "Execute exactly these workflow commands:",
      `1. ak create note --task ${task.id} "Completion Summary: addressed reviewer rejection and resubmitted through the task runner."`,
      `2. ak task review ${task.id}`,
    ].join("\n"),
  );
  return await annotateTask(db, task, {
    "ama.lastCommand": "reject_resume",
    "ama.lastCommand.result": "accepted",
  });
}

export async function stopTaskAmaSession(
  db: D1,
  env: Env,
  task: Task,
  reason: "user_requested" | "timeout" | "policy" | "runtime_error" = "user_requested",
) {
  const sessionId = amaSessionId(task);
  if (!sessionId || !isAmaRuntimeConfigured(env)) {
    return task;
  }
  await stopAmaSession(env, sessionId, reason);
  return await annotateTask(db, task, {
    "ama.lastCommand": "stop",
    "ama.lastCommand.result": "accepted",
  });
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

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringAnnotation(annotations: Annotations, key: string) {
  const value = annotations[key];
  return typeof value === "string" && value.length > 0 ? value : null;
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
