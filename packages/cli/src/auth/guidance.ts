import { detectRuntime } from "../agent/runtime.js";

export function missingAuthSessionMessage(runtime: string | null = detectRuntime()): string {
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
