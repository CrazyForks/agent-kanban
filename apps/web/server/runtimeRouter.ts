import { AGENT_RUNTIMES, type AgentRuntime, MACHINE_STALE_TIMEOUT_MS, type Task } from "@agent-kanban/shared";
import { getAmaProjectId } from "./amaOwnerIntegrationRepo";
import { type AmaRunner, isAmaTaskDispatchConfigured, listAmaRunners } from "./amaRuntime";
import type { D1 } from "./db";
import { legacyRuntimeAvailableOnMachines } from "./legacyRuntime";
import { listMachines } from "./machineRepo";
import type { Env } from "./types";

export type TaskRuntimeSource = "ama" | "legacy";

export const TASK_RUNTIME_SOURCE_ANNOTATION = "runtime.source";

export interface RuntimeSourceAvailability {
  ama: boolean;
  legacy: boolean;
}

export function amaRuntimeName(runtime: string): string {
  return runtime === "claude" ? "claude-code" : runtime;
}

export function amaRunnerHeartbeatFresh(runner: AmaRunner, now = Date.now()): boolean {
  if (!runner.lastHeartbeatAt) return false;
  const heartbeatAt = Date.parse(runner.lastHeartbeatAt);
  return Number.isFinite(heartbeatAt) && heartbeatAt >= now - MACHINE_STALE_TIMEOUT_MS;
}

export function amaRunnerOwnsRuntime(runner: AmaRunner, runtime: string, model: string | null = null): boolean {
  if (runner.status !== "active" || !amaRunnerHeartbeatFresh(runner)) return false;

  const inventory = runner.runtimeInventory ?? [];
  if (inventory.length > 0 && !inventory.some((entry) => entry.runtime === runtime && (entry.state === "ready" || entry.state === "limited"))) {
    return false;
  }

  const runtimeCapable = runner.capabilities.some(
    (capability) => capability === runtime || capability.startsWith(`runtime-provider-model:${runtime}:`),
  );
  if (!runtimeCapable) return false;
  if (!model) return true;
  return amaRunnerDeclaresModel(runner, runtime, model) || runner.capabilities.includes(runtime);
}

export function amaRunnerDeclaresModel(runner: AmaRunner, runtime: string, model: string): boolean {
  return runner.capabilities.some((capability) => {
    const declared = amaCapabilityModel(capability, runtime);
    return declared === model || declared === "*";
  });
}

export function amaCapabilityModel(capability: string, runtime: string): string | null {
  const prefix = `runtime-provider-model:${runtime}:`;
  if (!capability.startsWith(prefix)) return null;
  const rest = capability.slice(prefix.length);
  const separator = rest.indexOf(":");
  return separator === -1 ? null : rest.slice(separator + 1);
}

export async function resolveRuntimeSourceAvailability(
  db: D1,
  env: Env,
  ownerId: string,
  runtime: AgentRuntime,
  model: string | null = null,
): Promise<RuntimeSourceAvailability> {
  const machines = await listMachines(db, ownerId);
  const legacy = legacyRuntimeAvailableOnMachines(machines, runtime);
  if (!isAmaTaskDispatchConfigured(env)) {
    return { ama: false, legacy };
  }

  const environmentIds = [
    ...new Set(
      machines
        .filter((machine) => machine.runtimes.some((entry) => entry.name === runtime))
        .map((machine) => machine.ama_environment_id)
        .filter((environmentId): environmentId is string => Boolean(environmentId)),
    ),
  ];
  const projectId = environmentIds.length > 0 ? await getAmaProjectId(db, ownerId) : null;
  const runnerPages = projectId
    ? await Promise.all(environmentIds.map((environmentId) => listAmaRunners(env, ownerId, projectId, environmentId)))
    : [];
  const amaRuntime = amaRuntimeName(runtime);
  const cloudAvailable = machines.some(
    (machine) => machine.hosting === "cloud" && machine.runtimes.some((entry) => entry.name === runtime && entry.status === "ready"),
  );
  const ama = cloudAvailable || runnerPages.some((page) => page.data.some((runner) => amaRunnerOwnsRuntime(runner, amaRuntime, model)));
  return { ama, legacy };
}

export async function listAvailableRuntimeSources(db: D1, env: Env, ownerId: string): Promise<Map<AgentRuntime, RuntimeSourceAvailability>> {
  const machines = await listMachines(db, ownerId);
  const projectId = isAmaTaskDispatchConfigured(env) ? await getAmaProjectId(db, ownerId) : null;
  const environmentIds = [...new Set(machines.map((machine) => machine.ama_environment_id).filter((id): id is string => Boolean(id)))];
  const runnerPages = projectId
    ? await Promise.all(environmentIds.map((environmentId) => listAmaRunners(env, ownerId, projectId, environmentId)))
    : [];
  const entries = await Promise.all(
    AGENT_RUNTIMES.map(async (runtime) => {
      const amaRuntime = amaRuntimeName(runtime);
      const cloudAvailable = machines.some(
        (machine) => machine.hosting === "cloud" && machine.runtimes.some((entry) => entry.name === runtime && entry.status === "ready"),
      );
      const ama = cloudAvailable || runnerPages.some((page) => page.data.some((runner) => amaRunnerOwnsRuntime(runner, amaRuntime)));
      const legacy = legacyRuntimeAvailableOnMachines(machines, runtime);
      return [runtime, { ama, legacy }] as const;
    }),
  );
  return new Map(entries);
}

export function selectRuntimeSource(availability: RuntimeSourceAvailability): TaskRuntimeSource | null {
  if (availability.ama) return "ama";
  if (availability.legacy) return "legacy";
  return null;
}

export function taskRuntimeSource(task: Pick<Task, "metadata">): TaskRuntimeSource | null {
  const annotations = metadataObject(metadataObject(task.metadata).annotations);
  const source = annotations[TASK_RUNTIME_SOURCE_ANNOTATION];
  if (source === "ama" || source === "legacy") return source;
  if (typeof annotations["ama.sessionId"] === "string" || typeof annotations["ama.dispatch.result"] === "string") return "ama";
  return null;
}

export function metadataWithRuntimeSource(metadata: unknown, source: TaskRuntimeSource): Record<string, unknown> {
  const next = { ...metadataObject(metadata) };
  next.annotations = {
    ...metadataObject(next.annotations),
    [TASK_RUNTIME_SOURCE_ANNOTATION]: source,
  };
  return next;
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
