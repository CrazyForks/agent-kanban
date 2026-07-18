import { AGENT_RUNTIMES, type AgentRuntime, hasNoScheduleTaint, type Task } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { getAgent } from "./agentRepo";
import type { D1 } from "./db";
import { createLogger } from "./logger";
import {
  stringRuntimeAnnotation,
  TASK_RUNTIME_SOURCE_ANNOTATION,
  type TaskRuntimeSource,
  taskRuntimeAnnotations,
  taskRuntimeSource,
} from "./runtimeBinding";
import { compareAndSetTaskRuntimeSource, listPendingTaskRuntimeBindings, persistInferredAmaTaskRuntimeSource } from "./runtimeBindingRepo";
import { resolveRuntimeSourceAvailability, selectRuntimeSource } from "./runtimeRouter";
import { dispatchTaskToAma, releaseTaskRuntimeBinding } from "./taskDispatch";
import { getTask } from "./taskRepo";
import type { Env } from "./types";

const logger = createLogger("runtimeCoordinator");

interface DispatchOptions {
  apiOrigin: string;
  takeover?: boolean;
  recordFailure?: boolean;
}

export async function resolveAssignableWorkerRuntimeSource(
  db: D1,
  env: Env,
  ownerId: string,
  agentId: string,
  missingStatus: 400 | 404,
): Promise<TaskRuntimeSource> {
  const agent = await getAgent(db, agentId, ownerId);
  if (!agent) throw new HTTPException(missingStatus, { message: "Agent not found" });
  if (agent.kind !== "worker") throw new HTTPException(400, { message: "Tasks can only be assigned to worker agents" });
  if (hasNoScheduleTaint(agent.taints)) {
    throw new HTTPException(409, { message: "Agent is tainted NoSchedule and cannot be assigned normal tasks" });
  }

  const runtime = agent.runtime as AgentRuntime;
  const source = selectRuntimeSource(await resolveRuntimeSourceAvailability(db, env, ownerId, runtime, agent.model));
  if (!source) {
    throw new HTTPException(409, {
      message: `Runtime "${runtime}" is not available on any AMA runner or online legacy machine.`,
    });
  }
  return source;
}

export async function dispatchAssignedTask(db: D1, env: Env, ownerId: string, task: Task, options: DispatchOptions): Promise<Task> {
  if (taskRuntimeSource(task) !== "ama") return task;
  return await dispatchTaskToAma(db, env, ownerId, task, options);
}

export async function releaseAssignedTaskRuntime(
  db: D1,
  env: Env,
  ownerId: string,
  task: Task,
  reason: "user_requested" | "timeout" | "policy" | "runtime_error" = "user_requested",
): Promise<Task> {
  if (taskRuntimeSource(task) === "legacy") return task;
  return await releaseTaskRuntimeBinding(db, env, ownerId, task, reason);
}

export async function routePendingTasks(db: D1, env: Env): Promise<void> {
  for (const row of await listPendingTaskRuntimeBindings(db)) {
    const task = await getTask(db, row.id, row.ownerId);
    if (!task?.assigned_to) continue;
    const agent = await getAgent(db, task.assigned_to, row.ownerId);
    if (!agent || !AGENT_RUNTIMES.includes(agent.runtime as AgentRuntime)) continue;

    const runtime = agent.runtime as AgentRuntime;
    const availability = await resolveRuntimeSourceAvailability(db, env, row.ownerId, runtime, agent.model);
    const annotations = taskRuntimeAnnotations(task);
    const storedSource = stringRuntimeAnnotation(annotations, TASK_RUNTIME_SOURCE_ANNOTATION);
    const current: TaskRuntimeSource | null = storedSource === "ama" || storedSource === "legacy" ? storedSource : null;
    const hasAmaBinding = Boolean(stringRuntimeAnnotation(annotations, "ama.sessionId") || stringRuntimeAnnotation(annotations, "agentSessionId"));
    if (hasAmaBinding) {
      if (!current) await persistInferredAmaTaskRuntimeSource(db, task.id);
      continue;
    }

    let next = current;
    if (!current) {
      next = selectRuntimeSource(availability);
    } else if (current === "legacy" && !availability.legacy && availability.ama) {
      next = "ama";
    } else if (current === "ama" && !availability.ama && availability.legacy) {
      next = "legacy";
    }
    if (!next || next === current) continue;
    if (!(await compareAndSetTaskRuntimeSource(db, task.id, current, next))) continue;
    logger.info(`task runtime source selected task=${task.id} runtime=${runtime} previous=${current ?? "unrouted"} next=${next}`);
  }
}
