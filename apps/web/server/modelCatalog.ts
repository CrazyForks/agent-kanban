import type { AgentRuntime } from "@agent-kanban/shared";
import { getAmaProjectId } from "./amaOwnerIntegrationRepo";
import { isAmaTaskDispatchConfigured, listAmaRunners, listAmaRuntimeModels } from "./amaRuntime";
import type { D1 } from "./db";
import { listMachineEnvironmentCandidatesForRuntime } from "./machineRepo";
import { amaCapabilityModel, amaRuntimeName } from "./taskDispatch";
import type { Env } from "./types";

export interface RuntimeModel {
  id: string;
  name?: string;
}

// Models a runtime can run for this owner. The cloud catalog is owned by AMA
// (the authority — fetched, never hardcoded here); self-hosted runtimes get the
// models declared by the owner's live AMA runners via
// runtime-provider-model:<runtime>:<provider>:<model> capabilities.
export async function listRuntimeModels(db: D1, env: Env, ownerId: string, runtime: AgentRuntime): Promise<RuntimeModel[]> {
  if (!isAmaTaskDispatchConfigured(env)) return [];
  const amaRuntime = amaRuntimeName(runtime);
  // A non-empty AMA catalog means a cloud-hosted runtime; self-hosted-only
  // runtimes return [] and fall through to live runner-capability discovery.
  const cloudModels = await listAmaRuntimeModels(env, amaRuntime);
  if (cloudModels.length > 0) {
    return cloudModels.map((model) => ({ id: model.model, ...(model.displayName ? { name: model.displayName } : {}) }));
  }
  const projectId = await getAmaProjectId(db, ownerId);
  if (!projectId) return [];
  const candidates = await listMachineEnvironmentCandidatesForRuntime(db, ownerId, runtime);
  const environmentIds = [...new Set(candidates.map((candidate) => candidate.environmentId))];
  const modelIds = new Set<string>();
  for (const environmentId of environmentIds) {
    const runners = await listAmaRunners(env, projectId, environmentId);
    for (const runner of runners.data) {
      if (runner.status !== "active") continue;
      for (const capability of runner.capabilities) {
        const model = amaCapabilityModel(capability, amaRuntime);
        if (model && model !== "*") modelIds.add(model);
      }
    }
  }
  return [...modelIds].map((id) => ({ id }));
}
