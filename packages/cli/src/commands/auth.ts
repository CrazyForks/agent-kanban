import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Command } from "commander";
import { loadIdentity } from "../agent/identity.js";
import { createClient, loginLeaderAgent } from "../agent/leader.js";
import { detectRuntime, findRuntimeAncestorPid } from "../agent/runtime.js";
import { clearWorkerAuthSession, readWorkerAuthSession, writeWorkerAuthSession } from "../auth/session.js";
import { AgentClient } from "../client/agent.js";
import { getCredentials, saveCredentials } from "../config.js";
import { isPidAlive, listSessions } from "../session/store.js";
import { configureGithubAuth } from "./github.js";

async function maintainerLogin(): Promise<{ agentId: string; sessionId: string; reused: boolean }> {
  const apiUrl = process.env.AK_API_URL;
  const apiKey = process.env.AK_API_KEY;
  const agentId = process.env.AK_AGENT_ID;
  const boardId = process.env.AK_BOARD_ID;
  const maintainerId = process.env.AK_MAINTAINER_ID;
  if (!apiUrl || !apiKey || !agentId || !boardId || !maintainerId) {
    throw new Error("No AK maintainer auth environment found. Provide --api-url/--api-key or run inside an AK maintainer worker.");
  }

  const cached = readWorkerAuthSession();
  if (cached?.apiUrl === apiUrl && cached.agentId === agentId && cached.boardId === boardId && cached.maintainerId === maintainerId) {
    return { agentId: cached.agentId, sessionId: cached.sessionId, reused: true };
  }

  const { publicKey, privateKey } = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
  const pubJwk = await crypto.subtle.exportKey("jwk", publicKey);
  const privJwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (!pubJwk.x) throw new Error("Ed25519 key export missing x component");

  const sessionId = randomUUID();
  const res = await fetch(
    `${apiUrl.replace(/\/$/, "")}/api/boards/${encodeURIComponent(boardId)}/maintainers/${encodeURIComponent(maintainerId)}/sessions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        session_id: sessionId,
        session_public_key: pubJwk.x,
        ama_session_id: process.env.AMA_SESSION_ID || process.env.AK_AMA_SESSION_ID || null,
        ama_trigger_run_id: process.env.AMA_TRIGGER_RUN_ID || process.env.AK_AMA_TRIGGER_RUN_ID || null,
      }),
    },
  );
  const body = (await res.json().catch(() => null)) as { error?: { message?: string }; agent_id?: string; session_id?: string } | null;
  if (!res.ok) throw new Error(body?.error?.message || `Maintainer session creation failed with HTTP ${res.status}`);
  if (!body?.agent_id || !body.session_id) throw new Error("Maintainer session creation returned an invalid response");

  writeWorkerAuthSession({
    agentId: body.agent_id,
    sessionId: body.session_id,
    apiUrl,
    privateKeyJwk: privJwk,
    boardId,
    maintainerId,
    createdAt: Date.now(),
  });
  return { agentId: body.agent_id, sessionId: body.session_id, reused: false };
}

async function ensureAuthSession() {
  const fromEnv = await AgentClient.fromEnv();
  if (fromEnv) return fromEnv;
  if (process.env.AK_API_KEY && process.env.AK_MAINTAINER_ID) {
    await maintainerLogin();
    const client = await AgentClient.fromEnv();
    if (client) return client;
  }
  return await createClient();
}

function hasMaintainerLoginEnv(): boolean {
  return Boolean(
    process.env.AK_API_URL && process.env.AK_API_KEY && process.env.AK_AGENT_ID && process.env.AK_BOARD_ID && process.env.AK_MAINTAINER_ID,
  );
}

function missingAuthSessionMessage(): string {
  const base = "No AK auth session found.";

  if (process.env.AK_API_KEY && process.env.AK_MAINTAINER_ID) {
    return [base, "For a maintainer worker, run:", "  ak auth login"].join("\n");
  }

  if (process.env.AK_WORKER === "1" || process.env.AK_AGENT_ID || process.env.AK_SESSION_ID || process.env.AK_AGENT_KEY) {
    return [
      base,
      "This worker runtime is missing a complete AK agent session.",
      "The runtime should inject AK_AGENT_ID, AK_SESSION_ID, AK_AGENT_KEY, and AK_API_URL.",
    ].join("\n");
  }

  const runtime = detectRuntime();
  if (runtime) {
    return [
      base,
      `For a leader agent in the current ${runtime} runtime, run:`,
      "  ak auth login --leader-agent --username <username> [--name <name>]",
    ].join("\n");
  }

  return [
    base,
    "Run inside an AK worker with an injected session, or run from a supported leader agent runtime:",
    "  ak auth login --leader-agent --username <username> [--name <name>]",
  ].join("\n");
}

function repositoryProvider(repo: any): "github" {
  const url = String(repo?.url ?? "");
  if (url.includes("github.com:") || url.includes("github.com/")) return "github";
  throw new Error(`Unsupported git provider for repository URL: ${url}`);
}

function workerGithubAuthHome(): string {
  if (process.env.AMA_WORKSPACE_HOME) return process.env.AMA_WORKSPACE_HOME;
  if (process.env.AMA_WORKSPACE) return join(process.env.AMA_WORKSPACE, ".home");
  throw new Error("Refusing to modify GitHub credentials without an isolated worker HOME.");
}

export function registerAuthCommand(program: Command) {
  const authCmd = program.command("auth").description("Authenticate AK and repository access");

  authCmd
    .command("login")
    .description("Authenticate AK for the current user, machine, or agent worker")
    .option("--api-url <url>", "AK API server URL")
    .option("--api-key <key>", "AK API key")
    .option("--leader-agent", "Create a leader agent identity for the current runtime")
    .option("--username <username>", "Leader agent username when using --leader-agent")
    .option("--name <name>", "Leader agent display name when using --leader-agent")
    .action(async (opts) => {
      if (opts.apiUrl || opts.apiKey) {
        if (!opts.apiUrl || !opts.apiKey) throw new Error("--api-url and --api-key must be provided together");
        saveCredentials(opts.apiUrl, opts.apiKey);
        console.log(`Saved AK credentials for ${new URL(opts.apiUrl).host}`);
        return;
      }

      if (opts.leaderAgent) {
        if (!opts.username) throw new Error("--username is required with --leader-agent");
        const runtime = detectRuntime();
        if (!runtime) throw new Error("No supported agent runtime found. Run this command from inside an agent runtime.");
        const session = await loginLeaderAgent({ runtime: runtime as any, username: opts.username, name: opts.name });
        console.log(`${session.reusedIdentity ? "Using" : "Created"} AK leader agent identity ${session.identity.agent_id}`);
        console.log(`Created AK leader agent session ${session.sessionId}`);
        return;
      }

      if (!hasMaintainerLoginEnv() && detectRuntime()) {
        throw new Error("Leader agent login requires --leader-agent. Run: ak auth login --leader-agent --username <username> [--name <name>]");
      }

      const session = await maintainerLogin();
      console.log(`${session.reused ? "Using" : "Created"} AK agent session ${session.sessionId} for ${session.agentId}`);
    });

  authCmd
    .command("logout")
    .description("Clear the current worker AK auth session")
    .action(() => {
      clearWorkerAuthSession();
      console.log("Cleared AK worker auth session");
    });

  authCmd
    .command("whoami")
    .description("Show the current AK auth identity")
    .action(async () => {
      const client = await AgentClient.fromEnv();
      if (client) {
        console.log("Type:        agent");
        console.log(`Agent ID:    ${client.getAgentId()}`);
        console.log(`Session ID:  ${client.getSessionId()}`);
        return;
      }
      const cached = readWorkerAuthSession();
      if (cached) {
        console.log("Type:        agent");
        console.log(`Agent ID:    ${cached.agentId}`);
        console.log(`Session ID:  ${cached.sessionId}`);
        return;
      }
      const runtime = detectRuntime();
      if (runtime) {
        let identity: ReturnType<typeof loadIdentity> = null;
        try {
          identity = loadIdentity(runtime);
        } catch {
          identity = null;
        }
        if (identity) {
          console.log("Type:        leader");
          console.log(`Runtime:     ${runtime}`);
          console.log(`Agent ID:    ${identity.agent_id}`);
          const leaderPid = findRuntimeAncestorPid(runtime);
          let apiUrl: string | null = null;
          try {
            apiUrl = getCredentials().apiUrl;
          } catch {
            apiUrl = null;
          }
          const session =
            leaderPid !== null && apiUrl
              ? listSessions({ type: "leader" }).find(
                  (candidate) =>
                    candidate.pid === leaderPid &&
                    candidate.runtime === runtime &&
                    candidate.apiUrl === apiUrl &&
                    candidate.agentId === identity.agent_id &&
                    isPidAlive(leaderPid),
                )
              : null;
          if (session) console.log(`Session ID:  ${session.sessionId}`);
          console.log(`Name:        ${identity.name}`);
          console.log(`Fingerprint: ${identity.fingerprint}`);
          return;
        }
      }
      throw new Error(missingAuthSessionMessage());
    });

  authCmd
    .command("git <repo-id>")
    .description("Configure git authentication for an AK repository")
    .option("--print-token", "Print the minted provider token instead of configuring local tools")
    .action(async (repoId: string, opts) => {
      const client = await ensureAuthSession();
      const repo = await client.getRepository(repoId);
      const provider = repositoryProvider(repo);
      if (provider === "github") {
        const auth = await client.createRepositoryGithubToken(repoId);
        if (opts.printToken) {
          console.log(auth.token);
          return;
        }
        if (process.env.AK_WORKER !== "1") {
          throw new Error("Refusing to modify global git credentials outside an AK worker. Use --print-token.");
        }
        const ghStatus = await configureGithubAuth(auth.token, { homeDir: workerGithubAuthHome() });
        const ghMessage = ghStatus === "configured" ? "gh credentials configured" : "gh not found; git credentials configured";
        console.log(`Configured GitHub auth for ${auth.full_name}; ${ghMessage}; expires at ${auth.expires_at}`);
      }
    });
}
