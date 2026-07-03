import { randomUUID } from "node:crypto";
import type { Agent, AgentRuntime } from "@agent-kanban/shared";
import { AgentClient } from "../client/agent.js";
import { type ApiClient, ApiError } from "../client/base.js";
import { MachineClient } from "../client/machine.js";
import { getCredentials } from "../config.js";
import { isPidAlive, listSessions, removeSession, writeSession } from "../session/store.js";
import { loadIdentity, removeIdentity, type StoredIdentity, saveIdentity } from "./identity.js";
import { detectRuntime, findRuntimeAncestorPid } from "./runtime.js";

async function restoreIdentity(runtime: AgentRuntime, client: MachineClient): Promise<StoredIdentity | null> {
  const agents = (await client.listAgents()) as Agent[];
  const leaders = agents.filter((agent) => agent.kind === "leader" && agent.runtime === runtime);
  if (leaders.length !== 1) return null;
  const leader = leaders[0];
  const identity: StoredIdentity = { agent_id: leader.id, name: leader.name, fingerprint: leader.fingerprint };
  saveIdentity(runtime, identity);
  return identity;
}

async function hasValidLeaderAgent(client: MachineClient, agentId: string, runtime: AgentRuntime): Promise<boolean> {
  try {
    const agent = (await client.getAgent(agentId)) as Agent;
    return agent.kind === "leader" && agent.runtime === runtime;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

async function loadOrRestoreIdentity(runtime: AgentRuntime, client: MachineClient): Promise<StoredIdentity | null> {
  const local = loadIdentity(runtime);
  if (local) {
    if (await hasValidLeaderAgent(client, local.agent_id, runtime)) return local;
    removeIdentity(runtime);
  }
  return restoreIdentity(runtime, client);
}

export async function getIdentity(runtime: AgentRuntime): Promise<StoredIdentity | null> {
  return loadOrRestoreIdentity(runtime, new MachineClient());
}

export async function createIdentity(input: { runtime: AgentRuntime; username: string; name?: string }): Promise<StoredIdentity> {
  const existing = loadIdentity(input.runtime);
  if (existing) {
    throw new Error(`Identity for runtime "${input.runtime}" already exists.`);
  }

  const client = new MachineClient();
  const payload: { username: string; name?: string; runtime: AgentRuntime; kind: "leader" } = {
    username: input.username,
    runtime: input.runtime,
    kind: "leader",
  };
  if (input.name) payload.name = input.name;

  const agent = (await client.createAgent(payload)) as Agent;
  const identity: StoredIdentity = { agent_id: agent.id, name: agent.name, fingerprint: agent.fingerprint };
  saveIdentity(input.runtime, identity);
  return identity;
}

export async function loginLeaderAgent(input: { runtime: AgentRuntime; username: string; name?: string }): Promise<{
  identity: StoredIdentity;
  sessionId: string;
  reusedIdentity: boolean;
}> {
  const leaderPid = findRuntimeAncestorPid(input.runtime);
  if (leaderPid === null) {
    throw new Error(`Could not locate ${input.runtime} process in ancestry. ak must be invoked from inside a ${input.runtime} session.`);
  }

  const { apiUrl } = getCredentials();
  const client = new MachineClient();
  let identity = await loadOrRestoreIdentity(input.runtime, client);
  let reusedIdentity = true;
  if (!identity) {
    identity = await createIdentity({ runtime: input.runtime, username: input.username, name: input.name });
    reusedIdentity = false;
  }

  const existing = listSessions({ type: "leader" }).find(
    (session) => session.pid === leaderPid && session.runtime === input.runtime && session.apiUrl === apiUrl,
  );
  if (existing && isPidAlive(leaderPid)) {
    if (existing.agentId !== identity.agent_id) removeSession(existing.sessionId);
    else return { identity, sessionId: existing.sessionId, reusedIdentity };
  }

  const { publicKey, privateKey } = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
  const pubJwk = await crypto.subtle.exportKey("jwk", publicKey);
  const privJwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (!pubJwk.x) throw new Error("Ed25519 key export missing x component");

  const sessionId = randomUUID();
  await client.createSession(identity.agent_id, sessionId, pubJwk.x);

  writeSession({
    type: "leader",
    agentId: identity.agent_id,
    sessionId,
    pid: leaderPid,
    runtime: input.runtime,
    startedAt: Date.now(),
    apiUrl,
    privateKeyJwk: privJwk,
  });

  cachedLeaderClient = new AgentClient(apiUrl, identity.agent_id, sessionId, privateKey);
  return { identity, sessionId, reusedIdentity };
}

let cachedLeaderClient: AgentClient | null = null;

/**
 * Returns AgentClient for the current identity.
 * - Daemon-spawned workers: reads AK_AGENT_* env vars
 * - Leader agents: auto-initializes from runtime detection + session file
 * - No runtime: throws (human in terminal)
 */
export async function createClient(): Promise<ApiClient> {
  const fromEnv = await AgentClient.fromEnv();
  if (fromEnv) return fromEnv;

  if (cachedLeaderClient) return cachedLeaderClient;

  const runtime = detectRuntime() as AgentRuntime | null;
  if (!runtime) {
    throw new Error("This command requires agent identity. Run inside an agent runtime.");
  }

  // Anchor the leader session to the long-lived runtime process PID so it outlives
  // the ephemeral shell that spawns `ak`. Without this, every ak invocation would
  // create a fresh session that the daemon's heartbeat immediately reaps.
  const leaderPid = findRuntimeAncestorPid(runtime);
  if (leaderPid === null) {
    throw new Error(`Could not locate ${runtime} process in ancestry. ak must be invoked from inside a ${runtime} session.`);
  }

  const apiUrl = getCredentials().apiUrl;
  const existing = listSessions({ type: "leader" }).find(
    (session) => session.pid === leaderPid && session.runtime === runtime && session.apiUrl === apiUrl,
  );
  if (existing && isPidAlive(leaderPid)) {
    const key = await crypto.subtle.importKey("jwk", existing.privateKeyJwk, { name: "Ed25519" } as any, false, ["sign"]);
    cachedLeaderClient = new AgentClient(existing.apiUrl, existing.agentId, existing.sessionId, key);
    return cachedLeaderClient;
  }

  throw new Error(
    [
      "No AK agent session is available.",
      "For a leader agent, run:",
      "  ak auth login --leader-agent --username <username> [--name <name>]",
      "Maintainer workers should run:",
      "  ak auth login",
    ].join("\n"),
  );
}
