// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestAgent, seedUser } from "./helpers/db";

const MIGRATIONS_DIR = join(__dirname, "../apps/web/migrations");
const MIGRATIONS_BEFORE_SUBAGENTS = [
  "0001_initial.sql",
  "0002_rename_task_logs_to_task_notes.sql",
  "0003_agent_kind.sql",
  "0004_rename_task_notes_to_task_actions.sql",
  "0005_agent_runtime_required.sql",
  "0006_add_device_id.sql",
  "0007_task_seq.sql",
  "0008_board_sharing.sql",
  "0009_admin_fields.sql",
  "0010_board_type.sql",
  "0011_task_scheduled_at.sql",
  "0012_gpg_keys.sql",
  "0013_agent_identity.sql",
  "0014_agent_mailbox_token.sql",
  "0015_username_global_unique.sql",
  "0016_task_actions_session_id.sql",
  "0017_unique_leader_per_runtime.sql",
  "0018_agent_subagents.sql",
  "0019_agent_versions.sql",
  "0020_board_labels.sql",
] as const;

let mf: Miniflare;
let db: D1Database;

async function runMigration(db: D1Database, file: string) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
  for (const stmt of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await db.prepare(stmt).run();
  }
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-db" },
  });
  db = await mf.getD1Database("DB");
  for (const file of MIGRATIONS_BEFORE_SUBAGENTS) await runMigration(db, file);
});

afterAll(async () => {
  await mf.dispose();
});

describe("0021_subagents migration", () => {
  it("copies existing agent subagent references into the subagents table", async () => {
    const ownerId = "subagent-migration-owner";
    await seedUser(db, ownerId, "subagent-migration-owner@test.local");
    const referenced = await createTestAgent(db, ownerId, {
      username: "legacy-reviewer",
      name: "Legacy Reviewer",
      runtime: "claude",
      model: "claude-opus-4-6",
      bio: "Reviews code",
      soul: "Be precise.",
      role: "reviewer",
      skills: ["saltbo/agent-kanban@agent-kanban"],
    });
    const parent = await createTestAgent(db, ownerId, {
      username: "parent-agent",
      name: "Parent Agent",
      runtime: "claude",
      subagents: [referenced.id],
    });

    await runMigration(db, "0021_subagents.sql");

    const migrated = await db.prepare("SELECT * FROM subagents WHERE id = ?").bind(referenced.id).first<any>();
    expect(migrated).toMatchObject({
      id: referenced.id,
      owner_id: ownerId,
      username: "legacy-reviewer",
      name: "Legacy Reviewer",
      bio: "Reviews code",
      soul: "Be precise.",
      role: "reviewer",
    });
    expect(JSON.parse(migrated.models)).toEqual({ claude: "claude-opus-4-6" });
    expect(JSON.parse(migrated.skills)).toEqual(["saltbo/agent-kanban@agent-kanban"]);

    const parentAfter = await db.prepare("SELECT subagents FROM agents WHERE id = ?").bind(parent.id).first<{ subagents: string }>();
    expect(JSON.parse(parentAfter!.subagents)).toEqual([referenced.id]);
  });
});
