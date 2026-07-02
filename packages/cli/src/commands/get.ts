import { normalizeRuntime } from "@agent-kanban/shared";
import type { Command } from "commander";
import { createClient } from "../agent/leader.js";
import {
  formatAgent,
  formatAgentList,
  formatBoard,
  formatBoardList,
  formatLabelList,
  formatMaintainer,
  formatMaintainerList,
  formatModelList,
  formatRepository,
  formatRepositoryList,
  formatSessionEvent,
  formatSubagent,
  formatSubagentList,
  formatTask,
  formatTaskList,
  formatTaskListWide,
  formatTaskNotes,
  formatTaskSession,
  getOutputFormat,
  output,
} from "../output.js";
import { readSessionEvents, type SessionEventFilter } from "../sessionWs.js";

type AgentRef = {
  id: string;
  username: string;
  version: string;
  name: string;
  kind?: string;
  role?: string | null;
  runtime?: string;
  runtime_available?: boolean;
  created_at?: string;
};

function sortAgentVersions(agents: AgentRef[]): AgentRef[] {
  return [...agents].sort((a, b) => {
    if (a.version === "latest") return -1;
    if (b.version === "latest") return 1;
    return (b.created_at ?? "").localeCompare(a.created_at ?? "") || a.version.localeCompare(b.version);
  });
}

function formatAgentVersions(data: { username: string; versions: AgentRef[] }): string {
  if (data.versions.length === 0) return `No versions found for ${data.username}.`;
  const lines = [`${data.username}`];
  for (const agent of sortAgentVersions(data.versions)) {
    const version = agent.version.padEnd(8);
    const created = agent.created_at ? new Date(agent.created_at).toISOString().slice(0, 10) : "";
    lines.push(`  ${version} ${agent.id}  ${created}  ${agent.name}`);
  }
  return lines.join("\n");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function showSession(
  client: any,
  sessionId: string,
  opts: { watch?: boolean; all?: boolean; tool?: boolean; assistant?: boolean; verbose?: boolean; limit?: string; output?: string },
  source: "session" | "task" = "session",
) {
  if (opts.tool && opts.assistant) {
    console.error("--tool and --assistant cannot be used together");
    process.exit(1);
  }
  const fmt = getOutputFormat(opts.output);
  if (fmt !== "text" && opts.watch) {
    console.error("--watch only supports text output");
    process.exit(1);
  }

  const mode: SessionEventFilter = opts.tool ? "tool" : opts.assistant ? "assistant" : "all";
  const { url } = source === "task" ? await client.getTaskSessionWs(sessionId) : await client.getSessionWs(sessionId);
  let recentLimit: number | undefined;
  if (opts.limit !== undefined) {
    const parsedLimit = Number.parseInt(opts.limit, 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      console.error("--limit must be a positive number");
      process.exit(1);
    }
    recentLimit = parsedLimit;
  }
  const session = source === "task" ? await client.getTaskSession(sessionId) : await client.getSession(sessionId);

  if (fmt !== "text") {
    try {
      const events = await readSessionEvents(url, {
        all: opts.all,
        watch: false,
        filter: mode,
        recentLimit,
      });
      output({ ...session, events }, fmt, undefined, { kind: "session" });
    } catch (error) {
      output({ ...session, events: [], events_error: errorMessage(error) }, fmt, undefined, { kind: "session" });
    }
    if (!process.env.VITEST_WORKER_ID) {
      process.exit(0);
    }
    return;
  }

  if (!opts.tool && !opts.assistant) {
    console.log(formatTaskSession(session));
    const eventLabel = opts.all ? "Events" : `Recent events${recentLimit ? ` (last ${recentLimit})` : ""}`;
    console.log(`\n${eventLabel}:`);
  }

  let printed = false;
  let eventsError: string | null = null;
  try {
    await readSessionEvents(url, {
      all: opts.all,
      watch: opts.watch,
      filter: mode,
      recentLimit,
      onEvent: (event) => {
        printed = true;
        const line = formatSessionEvent(event, mode, { verbose: opts.verbose });
        if (line) console.log(line);
      },
    });
  } catch (error) {
    eventsError = errorMessage(error);
  }

  if (!printed && !opts.tool && !opts.assistant) {
    console.log(eventsError ? `  unavailable: ${eventsError}` : "  none");
  } else if (eventsError) {
    console.error(`Session events unavailable: ${eventsError}`);
  }
  if (!opts.watch && !process.env.VITEST_WORKER_ID) {
    process.exit(0);
  }
}

async function getAgentOrVersions(client: any, id: string): Promise<{ value: any; formatter: (value: any) => string }> {
  try {
    return { value: await client.getAgent(id), formatter: formatAgent };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const agents = (await client.listAgents()) as AgentRef[];
  const versions = sortAgentVersions(agents.filter((agent) => agent.username === id));
  if (versions.length === 0) {
    console.error(`Agent not found: ${id}`);
    process.exit(1);
  }
  return { value: { username: id, versions }, formatter: formatAgentVersions };
}

export function registerGetCommand(program: Command) {
  const getCmd = program.command("get").description("Get a resource or list resources");

  getCmd
    .command("board [id]")
    .description("Get a board or list boards")
    .option("-o, --output <format>", "Output format (json, yaml, text)")
    .action(async (id: string | undefined, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      if (id) {
        const board = await client.getBoard(id);
        output(board, fmt, formatBoard, { kind: "board" });
      } else {
        const boards = await client.listBoards();
        output(boards, fmt, formatBoardList, { kind: "board" });
      }
    });

  getCmd
    .command("label")
    .description("List board labels")
    .requiredOption("--board <id>", "Board ID")
    .option("-o, --output <format>", "Output format (json, yaml, text)")
    .action(async (opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const board = await client.getBoard(opts.board);
      output(board.labels ?? [], fmt, formatLabelList, { kind: "label" });
    });

  getCmd
    .command("task [id]")
    .description("Get a task or list tasks")
    .option("-o, --output <format>", "Output format (json, yaml, wide, text)")
    .option("--board <id>", "Board ID (required when listing)")
    .option("--status <status>", "Filter by status")
    .option("--label <label>", "Filter by label")
    .option("--repo <id>", "Filter by repository ID")
    .option("--session", "Show task session state and events")
    .action(async (id: string | undefined, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      if (id) {
        if (opts.session) {
          await showSession(client, id, opts, "task");
        } else {
          const task = await client.getTask(id);
          output(task, fmt, formatTask, { kind: "task" });
        }
      } else {
        if (opts.session) {
          console.error("Usage: ak get task <task-id> --session");
          process.exit(1);
        }
        if (!opts.board) {
          console.error("Error: --board is required when listing tasks\nUsage: ak get task --board <id>");
          process.exit(1);
        }
        const params: Record<string, string> = { board_id: opts.board };
        if (opts.status) params.status = opts.status;
        if (opts.label) params.label = opts.label;
        if (opts.repo) params.repository_id = opts.repo;
        const tasks = await client.listTasks(params);
        output(tasks, fmt, formatTaskList, { wideFormatter: formatTaskListWide, kind: "task" });
      }
    });

  getCmd
    .command("session <sessionId>")
    .description("Show a runtime session state and events")
    .option("--watch", "Keep streaming new events")
    .option("--all", "Backfill all historical events")
    .option("--limit <n>", "Number of recent events to show without --all", "20")
    .option("--tool", "Only show tool calls")
    .option("--assistant", "Only show agent text output")
    .option("--verbose", "Show longer event summaries")
    .option("-o, --output <format>", "Output format (json, yaml, text)")
    .action(async (sessionId: string, opts) => {
      const client = await createClient();
      await showSession(client, sessionId, opts);
    });

  getCmd
    .command("maintainer [id]")
    .description("Get board maintainers")
    .requiredOption("--board <id>", "Board ID")
    .option("--runs", "Show heartbeat run history for one maintainer")
    .option("--limit <n>", "Maximum run history entries", "20")
    .option("-o, --output <format>", "Output format (json, yaml, text)")
    .action(async (id: string | undefined, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const maintainers = await client.listBoardMaintainers(opts.board);
      if (id) {
        const maintainer = maintainers.find((candidate) => candidate.id === id);
        if (!maintainer) {
          console.error(`Maintainer not found: ${id}`);
          process.exit(1);
        }
        if (opts.runs) {
          const limit = Number.parseInt(opts.limit, 10);
          const runs = await client.listBoardMaintainerRuns(opts.board, id, { limit: Number.isFinite(limit) ? limit : 20 });
          output(runs, fmt, (page) => {
            const data = Array.isArray(page.data) ? page.data : [];
            if (data.length === 0) return "No maintainer runs found.";
            return data
              .map((run: any) => {
                const session = run.sessionId ? ` session=${run.sessionId}` : "";
                const error = run.errorMessage ? ` error=${run.errorMessage}` : "";
                return `  ${run.id}  [${run.status}] scheduled=${run.scheduledFor}${session}${error}`;
              })
              .join("\n");
          });
          return;
        }
        output(maintainer, fmt, formatMaintainer, { kind: "maintainer" });
      } else {
        if (opts.runs) {
          console.error("--runs requires a maintainer id");
          process.exit(1);
        }
        output(maintainers, fmt, formatMaintainerList, { kind: "maintainer" });
      }
    });

  getCmd
    .command("agent [id]")
    .description("Get an agent or list agents")
    .option("-o, --output <format>", "Output format (json, yaml, text)")
    .option("--role <role>", "Filter by agent role")
    .option("--runtime <runtime>", "Filter by runtime")
    .option("--available", "Only show agents whose runtime is available")
    .action(async (id: string | undefined, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      if (id) {
        const { value, formatter } = await getAgentOrVersions(client, id);
        output(value, fmt, formatter, { kind: "agent" });
      } else {
        const params: Record<string, string> = { kind: "worker" };
        if (opts.role) params.role = opts.role;
        if (opts.runtime) params.runtime = opts.runtime;
        if (opts.available) params.available = "true";
        const agents = (await client.listAgents(params)) as AgentRef[];
        output(agents, fmt, formatAgentList, { kind: "agent" });
      }
    });

  getCmd
    .command("subagent [id]")
    .description("Get a task-local subagent or list subagents")
    .option("-o, --output <format>", "Output format (json, yaml, text)")
    .action(async (id: string | undefined, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      if (id) {
        const subagent = await client.getSubagent(id);
        output(subagent, fmt, formatSubagent, { kind: "subagent" });
      } else {
        const subagents = await client.listSubagents();
        output(subagents, fmt, formatSubagentList, { kind: "subagent" });
      }
    });

  getCmd
    .command("model")
    .description("List available models for a runtime")
    .requiredOption("--runtime <runtime>", "Runtime name")
    .option("-o, --output <format>", "Output format (json, yaml, text)")
    .action(async (opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const models = await client.listModels(normalizeRuntime(opts.runtime));
      output(models, fmt, formatModelList, { kind: "model" });
    });

  getCmd
    .command("repo [id]")
    .description("Get a repository or list repositories")
    .option("--board <id>", "Only list repositories associated with a board")
    .option("-o, --output <format>", "Output format (json, yaml, text)")
    .action(async (id: string | undefined, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      if (id) {
        const repo = await client.getRepository(id);
        output(repo, fmt, formatRepository, { kind: "repo" });
      } else {
        const repos = await client.listRepositories(opts.board ? { board_id: opts.board } : undefined);
        output(repos, fmt, formatRepositoryList, { kind: "repo" });
      }
    });

  getCmd
    .command("note [task-id]")
    .description("Get notes for a task")
    .option("-o, --output <format>", "Output format (json, text)")
    .option("--task <id>", "Task ID")
    .option("--since <timestamp>", "Only show notes after this timestamp")
    .action(async (taskId: string | undefined, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const id = taskId ?? opts.task;
      if (!id) {
        console.error("Usage: ak get note <task-id>  or  ak get note --task <task-id>");
        process.exit(1);
      }
      const notes = await client.getTaskNotes(id, opts.since);
      output(notes, fmt, formatTaskNotes);
    });
}
