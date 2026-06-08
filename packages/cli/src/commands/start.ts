import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { MachineRuntime } from "@agent-kanban/shared";
import type { Command } from "commander";
import { type AmaRunnerVersionInfo, resolveAmaRunnerBinary } from "../amaRunner.js";
import { getCredentials, saveCredentials, setCurrent } from "../config.js";
import { generateDeviceId } from "../device.js";
import { resolveMachineName } from "../machineName.js";
import { DAEMON_STATE_FILE, LOGS_DIR, PID_FILE, SESSIONS_DIR, STATE_DIR } from "../paths.js";
import { getAvailableProviders } from "../providers/registry.js";
import { listSessions } from "../session/store.js";
import { getVersion } from "../version.js";

const MAX_LOG_ARCHIVES = 5;
const DEFAULT_MAX_CONCURRENT = 5;
interface DaemonState {
  providers: string[];
  maxConcurrent: number;
  pollInterval: number;
  taskTimeout: number;
  apiUrl: string;
  startedAt: string;
  runtime?: "legacy-daemon" | "ama-runner";
  runnerPath?: string;
  runnerVersion?: AmaRunnerVersionInfo | null;
}

interface AmaRunnerOnboardingResponse {
  origin: string;
  projectId: string;
  environmentId: string;
  accessToken: string;
  refreshToken: string;
  tokenType?: string;
  expiresIn?: number | null;
}

interface RegisteredMachine {
  id: string;
  name: string;
  runner?: AmaRunnerOnboardingResponse | null;
}

function rotateLogs(): void {
  mkdirSync(LOGS_DIR, { recursive: true });
  const logFile = join(LOGS_DIR, "daemon.log");
  if (!existsSync(logFile)) return;

  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "");
  renameSync(logFile, join(LOGS_DIR, `daemon-${timestamp}.log`));

  const archives = readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith("daemon-") && f.endsWith(".log"))
    .sort();

  while (archives.length > MAX_LOG_ARCHIVES) {
    unlinkSync(join(LOGS_DIR, archives.shift()!));
  }
}

function readDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function readDaemonState(): DaemonState | null {
  try {
    return JSON.parse(readFileSync(DAEMON_STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function formatUptime(startMs: number): string {
  const seconds = Math.floor((Date.now() - startMs) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function countActiveSessions(): number {
  // Count worker sessions that are still doing work. "closed" sessions stay
  // on disk for history lookup but are no longer active.
  return listSessions({ type: "worker" }).filter((s) => s.status !== "closed").length;
}

export function listRunningTaskSessions(): { sessionId: string; taskId: string }[] {
  return listSessions({ type: "worker", status: "active" })
    .filter((s) => Boolean(s.taskId))
    .map((s) => ({ sessionId: s.sessionId, taskId: s.taskId! }));
}

export async function confirmDaemonShutdown(action: "stop" | "restart", yes: boolean): Promise<void> {
  const running = listRunningTaskSessions();
  if (running.length === 0 || yes) return;

  const taskList = running.map((s) => `  - ${s.taskId} (session ${s.sessionId.slice(0, 8)})`).join("\n");
  const message = `${action === "stop" ? "Stopping" : "Restarting"} the daemon will release ${running.length} active task(s) back to todo:\n${taskList}`;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`${message}\nRe-run with -y/--yes to confirm.`);
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${message}\nContinue? [y/N] `);
  rl.close();

  if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
    console.log("Cancelled");
    process.exit(1);
  }
}

function formatProviders(all: string[]): string {
  if (all.length === 0) return "none";
  return all.join(", ");
}

function maskApiUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

function amaRunnerArgs(opts: Record<string, unknown>): string[] {
  const args: string[] = [];
  const add = (flag: string, value: unknown) => {
    if (typeof value === "string" && value.length > 0) args.push(flag, value);
  };
  add("--config", opts.amaConfigPath);
  add("--api-server", opts.amaOrigin);
  add("--project-id", opts.amaProjectId);
  add("--environment-id", opts.amaEnvironmentId);
  add("--workdir", opts.amaWorkdir);
  add("--max-concurrent", opts.maxConcurrent);
  if (opts.amaAllowUnsafeProcess !== false) args.push("--allow-unsafe-process");
  return args;
}

function amaRunnerOrigin(opts: Record<string, unknown>) {
  return (typeof opts.amaOrigin === "string" && opts.amaOrigin) || "machine-runner";
}

function akApiUrl(opts: Record<string, unknown>) {
  return (typeof opts.apiUrl === "string" && opts.apiUrl) || amaRunnerOrigin(opts);
}

function machineRuntimes(): MachineRuntime[] {
  const providers = getAvailableProviders();
  if (providers.length === 0) throw new Error("No local runtime provider is available");
  const checkedAt = new Date().toISOString();
  return providers.map((provider) => ({ name: provider.name, status: "ready", checked_at: checkedAt }));
}

async function waitForSpawn(child: ReturnType<typeof spawn>, runnerBin: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    if (typeof child.once !== "function") {
      if (typeof child.pid === "number") resolve(child.pid);
      else reject(new Error(`Machine runner did not report a process id: ${runnerBin}`));
      return;
    }
    let settled = false;
    child.once("spawn", () => {
      settled = true;
      if (typeof child.pid === "number") {
        resolve(child.pid);
        return;
      }
      reject(new Error(`Machine runner did not report a process id: ${runnerBin}`));
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") {
        reject(new Error(`Machine runner executable not found: ${runnerBin}`));
        return;
      }
      reject(error);
    });
  });
}

async function startAmaRunner(opts: Record<string, unknown>) {
  const existingPid = readDaemonPid();
  if (existingPid) {
    console.error(`Runtime already running (PID ${existingPid}). Stop it first or remove ${PID_FILE}`);
    process.exit(1);
  }
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  rotateLogs();

  const logFile = join(LOGS_DIR, "daemon.log");
  const logFd = openSync(logFile, "a");
  await applyAmaRunnerOnboarding(opts);
  const runner = await resolveAmaRunnerBinary();
  const args = amaRunnerArgs(opts);
  const env = { ...process.env };
  delete env.AMA_TOKEN;
  const child = spawn(runner.path, args, { detached: true, stdio: ["ignore", logFd, logFd], env });
  let pid: number;
  try {
    pid = await waitForSpawn(child, runner.path);
  } catch (error) {
    closeSync(logFd);
    throw error;
  }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid));
  const state: DaemonState = {
    providers: ["machine-runner"],
    maxConcurrent: parseInt(String(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT), 10),
    pollInterval: 0,
    taskTimeout: 0,
    apiUrl: akApiUrl(opts),
    startedAt: new Date().toISOString(),
    runtime: "ama-runner",
    runnerPath: runner.path,
    runnerVersion: runner.version,
  };
  writeFileSync(DAEMON_STATE_FILE, JSON.stringify(state, null, 2));
  child.unref();
  console.log(`● Machine runner started (PID ${pid}, v${getVersion()})`);
  console.log(`  API:         ${maskApiUrl((typeof opts.apiUrl === "string" && opts.apiUrl) || state.apiUrl)}`);
  console.log(`  Concurrency: ${state.maxConcurrent}`);
  if (state.runnerVersion?.version) console.log(`  Runner:      ama-runner ${state.runnerVersion.version}`);
  console.log(`  Logs:        ${logFile}`);
}

async function applyAmaRunnerOnboarding(opts: Record<string, unknown>) {
  let creds: { apiUrl: string; apiKey: string };
  if (typeof opts.apiUrl === "string" && typeof opts.apiKey === "string") {
    creds = { apiUrl: opts.apiUrl, apiKey: opts.apiKey };
  } else if (typeof opts.apiUrl === "string") {
    try {
      creds = getCredentials(new URL(opts.apiUrl).host);
    } catch {
      return;
    }
  } else {
    try {
      creds = getCredentials();
    } catch {
      return;
    }
  }

  const runtimes = machineRuntimes();
  const machineResponse = await fetch(`${creds.apiUrl.replace(/\/$/, "")}/api/machines`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creds.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: resolveMachineName(),
      os: `${platform()} ${arch()} ${release()}`,
      version: getVersion(),
      runtimes,
      device_id: generateDeviceId(),
    }),
  });
  if (!machineResponse.ok) {
    throw new Error(`Machine registration failed with HTTP ${machineResponse.status}: ${await machineResponse.text()}`);
  }
  const machine = (await machineResponse.json()) as RegisteredMachine;
  const onboarding = machine.runner;
  if (!onboarding?.accessToken || !onboarding.refreshToken) {
    throw new Error("Machine registration did not return AMA runner onboarding credentials");
  }
  opts.amaOrigin = onboarding.origin;
  opts.amaProjectId = onboarding.projectId;
  opts.amaEnvironmentId = onboarding.environmentId;
  opts.amaConfigPath = writeAmaRunnerConfig(onboarding);
}

function writeAmaRunnerConfig(onboarding: AmaRunnerOnboardingResponse): string {
  mkdirSync(STATE_DIR, { recursive: true });
  const configPath = join(STATE_DIR, "ama-runner-config.json");
  const expiresAt =
    typeof onboarding.expiresIn === "number" && onboarding.expiresIn > 0
      ? new Date(Date.now() + onboarding.expiresIn * 1000).toISOString()
      : undefined;
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        apiServer: onboarding.origin.replace(/\/$/, ""),
        accessToken: onboarding.accessToken,
        refreshToken: onboarding.refreshToken,
        tokenType: onboarding.tokenType ?? "Bearer",
        ...(expiresAt ? { expiresAt } : {}),
        projectId: onboarding.projectId,
        environmentId: onboarding.environmentId,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return configPath;
}

export function registerStartCommand(program: Command) {
  program
    .command("start")
    .description("Start the Machine runner")
    .option("--api-url <url>", "API server URL")
    .option("--api-key <key>", "AK API key")
    .option("--max-concurrent <n>", "Max concurrent agents", String(DEFAULT_MAX_CONCURRENT))
    .option("--poll-interval <ms>", "Poll interval in ms", "10000")
    .option("--task-timeout <ms>", "Task timeout in ms (0 to disable)", "7200000")
    .action(async (opts) => {
      // Save or resolve credentials
      if (opts.apiUrl && opts.apiKey) {
        saveCredentials(opts.apiUrl, opts.apiKey);
      } else if (opts.apiUrl) {
        // Switch to existing credentials for this host
        try {
          setCurrent(opts.apiUrl);
        } catch {
          console.error(`No saved credentials for ${opts.apiUrl}. Pass --api-key as well.`);
          process.exit(1);
        }
      }

      let creds: { apiUrl: string; apiKey: string };
      try {
        creds = getCredentials();
      } catch {
        console.error("API URL and key required. Pass --api-url and --api-key.");
        process.exit(1);
      }

      // Clear session cache if API URL changed. Sessions are backend-specific
      // and must not survive environment switches. Identities are now scoped
      // by api-url + machine + runtime, so they remain valid side by side.
      const prevState = readDaemonState();
      if (prevState && prevState.apiUrl !== creds.apiUrl) {
        rmSync(SESSIONS_DIR, { recursive: true, force: true });
      }
      await startAmaRunner({ ...opts, apiUrl: creds.apiUrl, apiKey: creds.apiKey });
    });
}

export function registerStopCommand(program: Command) {
  program
    .command("stop")
    .description("Stop the Machine runner")
    .option("-y, --yes", "Confirm stopping active tasks without prompting")
    .action(async (opts) => {
      const pid = readDaemonPid();
      if (!pid) {
        console.log("○ Machine runner is not running");
        return;
      }

      await confirmDaemonShutdown("stop", Boolean(opts.yes));

      let uptimeStr = "";
      const state = readDaemonState();
      if (state?.startedAt) {
        uptimeStr = formatUptime(new Date(state.startedAt).getTime());
      }

      process.kill(pid, "SIGTERM");

      // Wait for the process to actually exit (up to 10s)
      const deadline = Date.now() + 10_000;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          break; // Process exited
        }
        await sleep(200);
      }

      // Check if it's still alive
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        // dead — good
      }

      if (alive) {
        process.kill(pid, "SIGKILL");
        console.log(`● Machine runner force-killed (PID ${pid}, SIGTERM timed out)`);
      } else {
        console.log(`● Machine runner stopped (PID ${pid})`);
      }
      if (uptimeStr) console.log(`  Uptime: ${uptimeStr}`);
    });
}

export function registerStatusCommand(program: Command) {
  program
    .command("status")
    .description("Show Machine runner status")
    .action(() => {
      const pid = readDaemonPid();
      if (!pid) {
        console.log("○ Machine runner is not running");
        return;
      }

      const state = readDaemonState();

      let uptimeStr = "";
      if (state?.startedAt) {
        uptimeStr = formatUptime(new Date(state.startedAt).getTime());
      } else {
        try {
          uptimeStr = formatUptime(statSync(PID_FILE).mtimeMs);
        } catch {
          /* skip */
        }
      }

      const sessions = countActiveSessions();

      console.log(`● Machine runner running (PID ${pid}, v${getVersion()})`);
      if (uptimeStr) console.log(`  Uptime:      ${uptimeStr}`);
      if (state) {
        const providersLabel = formatProviders(state.providers ?? []);
        console.log(`  Providers:   ${providersLabel}`);
        console.log(`  Concurrency: ${state.maxConcurrent}`);
        console.log(`  API:         ${maskApiUrl(state.apiUrl)}`);
      }
      if (state?.runtime !== "ama-runner") console.log(`  Sessions:    ${sessions} active`);
    });
}

export function registerRestartCommand(program: Command) {
  program
    .command("restart")
    .description("Restart the Machine runner")
    .option("--api-url <url>", "API server URL")
    .option("--api-key <key>", "AK API key")
    .option("--max-concurrent <n>", "Max concurrent agents")
    .option("--poll-interval <ms>", "Poll interval in ms")
    .option("--task-timeout <ms>", "Task timeout in ms (0 to disable)")
    .option("-y, --yes", "Confirm stopping active tasks without prompting")
    .action(async (opts) => {
      const prevState = readDaemonState();

      // Stop existing runtime if running
      const pid = readDaemonPid();
      if (pid) {
        await confirmDaemonShutdown("restart", Boolean(opts.yes));
        process.kill(pid, "SIGTERM");

        const deadline = Date.now() + 10_000;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await sleep(200);
        }

        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          // dead — good
        }

        if (alive) {
          process.kill(pid, "SIGKILL");
          console.log(`● Machine runner force-killed (PID ${pid})`);
        } else {
          console.log(`● Machine runner stopped (PID ${pid})`);
        }
      } else {
        console.log("○ Machine runner was not running");
      }

      if (opts.apiUrl && opts.apiKey) {
        saveCredentials(opts.apiUrl, opts.apiKey);
      } else if (opts.apiUrl) {
        try {
          setCurrent(opts.apiUrl);
        } catch {
          console.error(`No saved credentials for ${opts.apiUrl}. Pass --api-key as well.`);
          process.exit(1);
        }
      }

      let creds: { apiUrl: string; apiKey: string };
      try {
        creds = getCredentials();
      } catch {
        console.error("API URL and key required. Pass --api-url and --api-key, or run `ak start` first.");
        process.exit(1);
      }

      // Clear session cache if API URL changed
      if (prevState && prevState.apiUrl !== creds.apiUrl) {
        rmSync(SESSIONS_DIR, { recursive: true, force: true });
      }
      await startAmaRunner({
        ...opts,
        apiUrl: creds.apiUrl,
        apiKey: creds.apiKey,
        maxConcurrent: opts.maxConcurrent ?? String(prevState?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT),
      });
    });
}

const LOG_DIVIDER = "\n──────────────────────── daemon restarted ────────────────────────\n\n";
const FOLLOW_POLL_MS = 500;

function followLogFile(logFile: string): void {
  let currentInode: number | null = null;
  let currentOffset = 0;

  // Initialise inode/offset from current file end
  try {
    const stat = statSync(logFile);
    currentInode = stat.ino;
    currentOffset = stat.size;
  } catch {
    // File may not exist yet; will pick it up on first poll
  }

  const poll = (): void => {
    try {
      const stat = statSync(logFile);

      if (currentInode !== null && stat.ino !== currentInode) {
        // File was rotated — new daemon.log created
        process.stdout.write(LOG_DIVIDER);
        currentOffset = 0;
      }

      currentInode = stat.ino;

      if (stat.size > currentOffset) {
        const fd = openSync(logFile, "r");
        const buf = Buffer.alloc(stat.size - currentOffset);
        readSync(fd, buf, 0, buf.length, currentOffset);
        closeSync(fd);
        process.stdout.write(buf);
        currentOffset = stat.size;
      }
    } catch {
      // File temporarily absent during rotation — retry next tick
    }
  };

  const timer = setInterval(poll, FOLLOW_POLL_MS);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

export function registerLogsCommand(program: Command) {
  program
    .command("logs")
    .description("Show local runtime logs")
    .option("--lines <n>", "Number of lines to show", "50")
    .option("-f, --follow", "Stream new log lines as they appear")
    .action((opts) => {
      const logFile = join(LOGS_DIR, "daemon.log");
      if (!existsSync(logFile)) {
        console.log("No daemon logs found");
        return;
      }

      if (opts.follow) {
        // Print last N lines via tail, then hand off to our inode-aware follower
        const init = spawn("tail", ["-n", String(opts.lines), logFile], { stdio: "inherit" });
        init.on("exit", () => followLogFile(logFile));
      } else {
        const tail = spawn("tail", ["-n", String(opts.lines), logFile], { stdio: "inherit" });
        tail.on("exit", (code) => process.exit(code ?? 0));
      }
    });
}
