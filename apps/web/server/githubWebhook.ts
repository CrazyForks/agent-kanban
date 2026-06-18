import type { Task } from "@agent-kanban/shared";
import type { D1 } from "./db";
import { createLogger } from "./logger";
import { releaseTaskRuntimeBinding } from "./taskDispatch";
import { cancelTask, completeTask, getTask } from "./taskRepo";
import type { Env } from "./types";

const logger = createLogger("githubWebhook");

// PR state sync comes through a platform GitHub App: users install the app on
// their repositories (one click, no secrets) and GitHub delivers all
// installations' pull_request events to one endpoint, signed with the app
// webhook secret. The secret never leaves the platform; tenant routing is by
// pr_url, which only ever matches tasks inside the PR owner's own boards.

// GitHub signs the raw body with HMAC-SHA256: X-Hub-Signature-256: sha256=<hex>
export async function verifyGithubSignature(secret: string, body: string, signatureHeader: string): Promise<boolean> {
  const expected = signatureHeader.replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  // Constant-time comparison
  const expectedLower = expected.toLowerCase();
  if (actual.length !== expectedLower.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expectedLower.charCodeAt(i);
  }
  return diff === 0;
}

// PR merged → task done; PR closed without merge → task cancelled.
// Replaces the old daemon's 30s gh-CLI poll with real-time delivery.
export async function handleGithubPullRequestEvent(
  db: D1,
  env: Env,
  payload: { action?: string; pull_request?: { html_url?: string; merged?: boolean } },
): Promise<{ handled: boolean; tasks: string[] }> {
  if (payload.action !== "closed") return { handled: false, tasks: [] };
  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) return { handled: false, tasks: [] };
  const merged = payload.pull_request?.merged === true;

  const rows = await db
    .prepare(`
      SELECT t.id, t.status, b.owner_id FROM tasks t
      JOIN boards b ON t.board_id = b.id
      WHERE t.pr_url = ? AND t.status IN ('in_review', 'in_progress')
    `)
    .bind(prUrl)
    .all<{ id: string; status: string; owner_id: string }>();

  const transitioned: string[] = [];
  for (const row of rows.results) {
    let task: Task | null = null;
    if (merged) {
      if (row.status !== "in_review") {
        // PR merged while the task is still in_progress: the agent has not
        // submitted for review yet, and the state machine has no
        // machine-driven path from in_progress to done. Leave it to the agent.
        logger.warn(`PR merged for task ${row.id} while ${row.status}; skipping`);
        continue;
      }
      task = await completeTask(db, row.id, "machine", "github", "machine");
    } else {
      task = await cancelTask(db, row.id, "machine", "github", "machine");
    }
    if (!task) continue;
    transitioned.push(row.id);
    try {
      const fresh = await getTask(db, row.id, row.owner_id);
      if (fresh) await releaseTaskRuntimeBinding(db, env, row.owner_id, fresh);
    } catch (error) {
      logger.warn(`runtime teardown failed for task ${row.id} after PR ${merged ? "merge" : "close"}: ${error}`);
    }
  }
  return { handled: true, tasks: transitioned };
}
