import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch as nodeArch, platform as nodePlatform, tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNERS_DIR } from "./paths.js";

const AMA_RUNNER_REPOSITORY = "saltbo/any-managed-agents";
export const AMA_RUNNER_VERSION = "0.1.0";
const AMA_RUNNER_INSTALL_DIR = join(RUNNERS_DIR, "ama-runner");

export interface AmaRunnerVersionInfo {
  name?: string;
  version?: string;
  commit?: string;
  buildDate?: string;
}

export interface ResolvedAmaRunner {
  path: string;
  version: AmaRunnerVersionInfo | null;
}

function artifactPlatform(): { os: string; arch: string } {
  const os = nodePlatform();
  const arch = nodeArch();
  if (os !== "darwin" && os !== "linux") throw new Error(`Unsupported AMA runner platform: ${os}`);
  if (arch === "arm64") return { os, arch: "arm64" };
  if (arch === "x64") return { os, arch: "amd64" };
  throw new Error(`Unsupported AMA runner architecture: ${arch}`);
}

function releaseBaseUrl(version: string): string {
  return `https://github.com/${AMA_RUNNER_REPOSITORY}/releases/download/ama-runner-v${version}`;
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download AMA runner asset ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download AMA runner checksums ${url}: HTTP ${response.status}`);
  return await response.text();
}

function expectedSha256(checksums: string, artifactName: string): string {
  for (const line of checksums.split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file === artifactName && /^[a-f0-9]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  throw new Error(`AMA runner checksums do not include ${artifactName}`);
}

function assertSha256(data: Buffer, expected: string): void {
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error(`AMA runner checksum mismatch: expected ${expected}, got ${actual}`);
}

function readRunnerVersion(path: string): AmaRunnerVersionInfo | null {
  const result = spawnSync(path, ["version", "--json"], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout) as AmaRunnerVersionInfo;
  } catch {
    return null;
  }
}

function installedRunnerMatches(path: string, version: string): boolean {
  if (!existsSync(path)) return false;
  return readRunnerVersion(path)?.version === version;
}

function cleanupLegacyVersionedInstalls(): void {
  if (!existsSync(AMA_RUNNER_INSTALL_DIR)) return;
  for (const entry of readdirSync(AMA_RUNNER_INSTALL_DIR)) {
    const path = join(AMA_RUNNER_INSTALL_DIR, entry);
    if (/^v\d/.test(entry) && statSync(path).isDirectory()) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

async function installAmaRunner(version: string, targetPath: string): Promise<void> {
  const { os, arch } = artifactPlatform();
  const artifactName = `ama-runner-v${version}-${os}-${arch}.tar.gz`;
  const baseUrl = releaseBaseUrl(version);
  const [archive, checksums] = await Promise.all([fetchBytes(`${baseUrl}/${artifactName}`), fetchText(`${baseUrl}/checksums.txt`)]);
  assertSha256(archive, expectedSha256(checksums, artifactName));

  const tmpDir = mkdtempSync(join(tmpdir(), "ak-ama-runner-"));
  const archivePath = join(tmpDir, artifactName);
  writeFileSync(archivePath, archive);
  const tar = spawnSync("tar", ["-xzf", archivePath, "-C", tmpDir], { encoding: "utf-8" });
  if (tar.status !== 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`Failed to extract AMA runner: ${tar.stderr || tar.stdout}`);
  }
  mkdirSync(AMA_RUNNER_INSTALL_DIR, { recursive: true });
  rmSync(targetPath, { force: true });
  renameSync(join(tmpDir, "ama-runner"), targetPath);
  rmSync(tmpDir, { recursive: true, force: true });
  chmodSync(targetPath, 0o755);
}

export async function resolveAmaRunnerBinary(): Promise<ResolvedAmaRunner> {
  const version = AMA_RUNNER_VERSION;
  const targetPath = join(AMA_RUNNER_INSTALL_DIR, "ama-runner");
  cleanupLegacyVersionedInstalls();
  if (!installedRunnerMatches(targetPath, version)) {
    await installAmaRunner(version, targetPath);
  }
  if (!existsSync(targetPath)) throw new Error(`AMA runner installation did not produce ${targetPath}`);
  return { path: targetPath, version: readRunnerVersion(targetPath) };
}
