// @vitest-environment node

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const testDir = join(tmpdir(), `ak-ama-runner-test-${randomUUID()}`);
const runnersDir = join(testDir, "runners");

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return { ...actual, RUNNERS_DIR: runnersDir };
});

vi.mock("node:child_process", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    spawnSync: vi.fn((command: string, args: string[]) => {
      if (command === "tar") {
        const outputDir = args[args.indexOf("-C") + 1];
        fs.writeFileSync(path.join(outputDir, "ama-runner"), "runner");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "version") {
        return { status: 0, stdout: JSON.stringify({ name: "ama-runner", version: "0.1.0", commit: "test" }), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    }),
  };
});

const { resolveAmaRunnerBinary } = await import("../src/amaRunner.js");

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe("resolveAmaRunnerBinary", () => {
  it("installs a single AK-managed runner and removes legacy version directories", async () => {
    mkdirSync(join(runnersDir, "ama-runner", "v0.1.0", "darwin-arm64"), { recursive: true });
    writeFileSync(join(runnersDir, "ama-runner", "v0.1.0", "darwin-arm64", "ama-runner"), "old");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/checksums.txt")) {
        const checksum = "0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3";
        return new Response(
          [
            `${checksum} ama-runner-v0.1.0-darwin-arm64.tar.gz`,
            `${checksum} ama-runner-v0.1.0-darwin-amd64.tar.gz`,
            `${checksum} ama-runner-v0.1.0-linux-arm64.tar.gz`,
            `${checksum} ama-runner-v0.1.0-linux-amd64.tar.gz`,
          ].join("\n"),
        );
      }
      return new Response(Buffer.from("archive"));
    });

    const resolved = await resolveAmaRunnerBinary();

    expect(resolved.path).toBe(join(runnersDir, "ama-runner", "ama-runner"));
    expect(resolved.version).toMatchObject({ version: "0.1.0", commit: "test" });
    expect(existsSync(join(runnersDir, "ama-runner", "v0.1.0"))).toBe(false);
    expect(existsSync(join(runnersDir, "ama-runner", "ama-runner"))).toBe(true);
  });
});
