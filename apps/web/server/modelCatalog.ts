import type { AgentRuntime } from "@agent-kanban/shared";
import { getAmaProjectId } from "./amaOwnerIntegrationRepo";
import { isAmaTaskDispatchConfigured, listAmaRunners } from "./amaRuntime";
import type { D1 } from "./db";
import { listMachineEnvironmentCandidatesForRuntime } from "./machineRepo";
import { amaCapabilityModel, amaRuntimeName } from "./taskDispatch";
import type { Env } from "./types";

export interface RuntimeModel {
  id: string;
  name?: string;
}

// Cloud runtimes run on the AMA sandbox plane with a fixed model catalog —
// there are no machine runners to report model capabilities.
const CLOUD_RUNTIME_MODELS: Partial<Record<AgentRuntime, RuntimeModel[]>> = {
  // First entry is the default. kimi-k2.7-code is the primary cloud model;
  // gpt-oss-120b is a different-vendor backend that survives a moonshot-side
  // outage; kimi-k2.6 is kept for when its upstream is healthy.
  ama: [
    { id: "@cf/moonshotai/kimi-k2.7-code", name: "Kimi K2.7 Code (Workers AI)" },
    { id: "@cf/openai/gpt-oss-120b", name: "GPT-OSS 120B (Workers AI)" },
    { id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6 (Workers AI)" },
  ],
};

// Models a runtime can run for this owner: the static catalog for cloud
// runtimes, otherwise the models declared by the owner's live AMA runners
// via runtime-provider-model:<runtime>:<provider>:<model> capabilities.
export async function listRuntimeModels(db: D1, env: Env, ownerId: string, runtime: AgentRuntime): Promise<RuntimeModel[]> {
  const cloudModels = CLOUD_RUNTIME_MODELS[runtime];
  if (cloudModels) return cloudModels;
  if (!isAmaTaskDispatchConfigured(env)) return [];
  const projectId = await getAmaProjectId(db, ownerId);
  if (!projectId) return [];
  const candidates = await listMachineEnvironmentCandidatesForRuntime(db, ownerId, runtime);
  const environmentIds = [...new Set(candidates.map((candidate) => candidate.environmentId))];
  const amaRuntime = amaRuntimeName(runtime);
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
