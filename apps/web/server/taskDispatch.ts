import { generateKeypair, type Task } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { getAgent } from "./agentRepo";
import { bindRuntimeAgentSession, closeSession, createRuntimeAgentSession } from "./agentSessionRepo";
import { resolveAmaProjectId } from "./amaOwnerMappingRepo";
import {
  createAmaAgent,
  createAmaSessionSecret,
  createAmaTaskSession,
  isAmaRuntimeConfigured,
  isAmaTaskDispatchConfigured,
  readAmaAgent,
  resolveAmaProviderModelProfile,
  sendAmaSessionMessage,
  stopAmaSession,
} from "./amaRuntime";
import type { D1 } from "./db";
import { getRuntimeAgentMapping, upsertRuntimeAgentMapping } from "./runtimeAgentMappingRepo";
import { updateTask } from "./taskRepo";
import type { Env } from "./types";

type Annotations = Record<string, unknown>;

export async function dispatchTaskToAma(db: D1, env: Env, ownerId: string, task: Task, options: { apiOrigin: string }): Promise<Task> {
  if (!task.assigned_to || !isAmaTaskDispatchConfigured(env)) {
    return task;
  }

  const amaEnvironmentId = env.AMA_DEFAULT_ENVIRONMENT_ID;
  const amaProjectId = await resolveAmaProjectId(db, env, ownerId);
  if (!amaEnvironmentId) {
    throw new HTTPException(500, { message: "Task dispatch runtime is not configured" });
  }
  const amaAgent = await ensureAmaAgentForAkAgent(db, env, ownerId, task.assigned_to, amaProjectId, amaEnvironmentId);

  const sessionIdentity = await createAkAgentSessionIdentity(db, env, ownerId, task.assigned_to);
  let secret: Awaited<ReturnType<typeof createAmaSessionSecret>> | null = null;
  let dispatch: Awaited<ReturnType<typeof createAmaTaskSession>> | null = null;
  try {
    secret = await createAmaSessionSecret(env, {
      projectId: amaProjectId,
      name: secretReferenceName(sessionIdentity.sessionId),
      secretValue: JSON.stringify(sessionIdentity.privateKeyJwk),
      metadata: {
        purpose: "ak-agent-session",
        agentId: task.assigned_to,
      },
    });

    dispatch = await createAmaTaskSession(env, {
      projectId: amaProjectId,
      agentId: amaAgent.id,
      environmentId: amaEnvironmentId,
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
    await bindRuntimeAgentSession(db, sessionIdentity.sessionId, dispatch.sessionId);
  } catch (error) {
    await closeSession(db, sessionIdentity.sessionId);
    throw error;
  }

  return await annotateTask(db, task, {
    "ama.projectId": dispatch.projectId,
    "ak.agentId": task.assigned_to,
    "ama.agentId": amaAgent.id,
    "ama.environmentId": dispatch.environmentId,
    "ama.sessionId": dispatch.sessionId,
    "ama.session.status": dispatch.status,
    "ama.session.statusReason": dispatch.statusReason,
    "ama.runtimeSecretEnv.AK_AGENT_KEY": secret.activeVersionId,
    "ak.runtimeSessionId": sessionIdentity.sessionId,
    "ama.dispatch.result": "accepted",
  });
}

export async function ensureAmaAgentForAkAgent(db: D1, env: Env, ownerId: string, akAgentId: string, projectId: string, environmentId: string) {
  const existing = await getRuntimeAgentMapping(db, { ownerId, akAgentId, runtimeSource: "ama" });
  if (existing) {
    const live = await readAmaAgent(env, projectId, existing.runtimeAgentId);
    if (live) return live;
  }

  const akAgent = await getAgent(db, akAgentId, ownerId);
  if (!akAgent) throw new HTTPException(404, { message: "Assigned agent not found" });
  const runtimeProfile = await resolveAmaProviderModelProfile(env, projectId, {
    environmentId,
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
    metadata: {
      source: "agent-kanban",
      "ak.agentId": akAgent.id,
      "ak.agentUsername": akAgent.username,
      "ak.runtime": akAgent.runtime,
      "ama.environmentRuntime": runtimeProfile.runtime,
    },
  });
  await upsertRuntimeAgentMapping(db, {
    ownerId,
    akAgentId,
    runtimeSource: "ama",
    runtimeAgentId: agent.id,
    metadata: {
      projectId,
      provider: agent.provider,
      model: agent.model,
    },
  });
  return agent;
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
  await createRuntimeAgentSession(db, env, {
    ownerId,
    agentId,
    sessionId,
    sessionPublicKey: keypair.publicKeyBase64,
    runtimeSource: "ama",
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
