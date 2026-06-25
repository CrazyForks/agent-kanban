import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { createClient } from "../agent/leader.js";

type GithubAuthOptions = {
  homeDir?: string;
  run?: (file: string, args: string[], options?: { input?: string }) => Promise<unknown>;
};

async function runCommand(file: string, args: string[], options: { input?: string } = {}) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${file} ${args.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function githubCredentialLine(token: string): string {
  return `https://x-access-token:${token}@github.com`;
}

async function configureGitCredential(token: string, options: GithubAuthOptions = {}) {
  const home = options.homeDir ?? homedir();
  const credentialsPath = join(home, ".git-credentials");
  const line = githubCredentialLine(token);
  await mkdir(dirname(credentialsPath), { recursive: true });
  const existing = existsSync(credentialsPath) ? await readFile(credentialsPath, "utf-8") : "";
  const kept = existing.split("\n").filter((entry) => entry.trim() && !entry.includes("@github.com"));
  kept.push(line);
  await writeFile(credentialsPath, `${kept.join("\n")}\n`, { mode: 0o600 });
  await chmod(credentialsPath, 0o600);
  await (options.run ?? runCommand)("git", ["config", "--global", "credential.helper", "store"]);
}

async function configureGhCli(token: string, options: GithubAuthOptions = {}): Promise<"configured" | "missing"> {
  const run = options.run ?? runCommand;
  try {
    await run("gh", ["--version"]);
  } catch {
    return "missing";
  }
  await run("gh", ["auth", "login", "--hostname", "github.com", "--with-token"], { input: token });
  await run("gh", ["auth", "setup-git", "--hostname", "github.com"]);
  return "configured";
}

export async function configureGithubAuth(token: string, options: GithubAuthOptions = {}) {
  await configureGitCredential(token, options);
  return await configureGhCli(token, options);
}

export function registerGithubCommand(program: Command) {
  const githubCmd = program.command("github").description("GitHub helper commands");

  githubCmd
    .command("auth <repo-id>")
    .description("Configure git and gh authentication for an AK repository")
    .option("--git-only", "Only configure git credentials, skip gh auth")
    .option("--force", "Configure local git and gh even outside an AK worker environment")
    .option("--print-token", "Print the minted token instead of configuring local tools")
    .action(async (repoId: string, opts) => {
      const client = await createClient();
      const auth = await client.createRepositoryGithubToken(repoId);
      if (opts.printToken) {
        console.log(auth.token);
        return;
      }
      if (process.env.AK_WORKER !== "1" && !opts.force) {
        console.error("Refusing to modify global GitHub credentials outside an AK worker. Use --print-token or --force.");
        process.exit(1);
      }
      await configureGitCredential(auth.token);
      const ghStatus = opts.gitOnly ? "skipped" : await configureGhCli(auth.token);
      const ghMessage =
        ghStatus === "configured" ? "gh authenticated" : ghStatus === "missing" ? "gh not found; git credentials configured" : "gh auth skipped";
      console.log(`Configured GitHub auth for ${auth.full_name}; ${ghMessage}; expires at ${auth.expires_at}`);
    });
}
